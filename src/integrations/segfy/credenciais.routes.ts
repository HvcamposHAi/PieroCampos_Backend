/**
 * Rotas HTTP das CREDENCIAIS do Segfy (Admin > Segfy). Admin-only.
 *   - GET   /api/segfy/credenciais         → status (NUNCA devolve a senha).
 *   - PATCH /api/segfy/credenciais {email,senha} → cifra e grava (conta única).
 *   - POST  /api/segfy/credenciais/testar  → login REAL no Segfy; registra ok/erro.
 *
 * A senha trafega só no PATCH (sob TLS) e é cifrada em repouso (cipher.ts). Nenhuma
 * rota loga o corpo. `exigirAdmin` é a defesa real (não confiar só na UI).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirAdmin } from "../../middlewares/authSupabase";
import { logger } from "../../utils/logger";
import {
  obterCredenciaisSegfy,
  registrarTesteSegfy,
  salvarCredenciaisSegfy,
  statusCredenciaisSegfy,
} from "../../services/segfy-credenciais.service";
import { obterTokensSegfy } from "./segfy.multicalculo";

const router = Router();

router.get("/credenciais", exigirAdmin, async (_req: Request, res: Response) => {
  try {
    const status = await statusCredenciaisSegfy();
    res.json({ ok: true, ...status });
  } catch (e) {
    logger.error("[segfy.routes] status falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "status_failed", mensagem: (e as Error).message });
  }
});

const putSchema = z.object({
  email: z.string().trim().email("e-mail inválido"),
  senha: z.string().min(1, "senha obrigatória").max(200),
});

router.patch("/credenciais", exigirAdmin, async (req: Request, res: Response) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    await salvarCredenciaisSegfy({
      email: parsed.data.email,
      senha: parsed.data.senha,
      porEmail: req.user?.email ?? null,
    });
    const status = await statusCredenciaisSegfy();
    res.json({ ok: true, ...status });
  } catch (e) {
    logger.error("[segfy.routes] salvar falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "save_failed", mensagem: (e as Error).message });
  }
});

router.post("/credenciais/testar", exigirAdmin, async (_req: Request, res: Response) => {
  const creds = await obterCredenciaisSegfy();
  if (!creds) {
    res.status(409).json({ ok: false, erro: "sem_credenciais", mensagem: "Cadastre o login e a senha antes de testar." });
    return;
  }
  try {
    // forcar=true → não usa cache; login de verdade com as credenciais salvas.
    await obterTokensSegfy(true, { email: creds.email, password: creds.password });
    await registrarTesteSegfy(true, "Login OK");
    res.json({ ok: true, mensagem: "Login no Segfy OK." });
  } catch (e) {
    const msg = (e as Error).message;
    await registrarTesteSegfy(false, msg);
    logger.warn("[segfy.routes] teste de login falhou", { erro: msg });
    res.json({ ok: false, mensagem: msg });
  }
});

export const segfyRouter = router;
