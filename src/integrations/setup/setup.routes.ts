/**
 * Rotas do SETUP da corretora (Admin › Configuração da corretora). Todas gated
 * por `exigirAdmin` + `exigirCorretoraSelecionada` (escopo por corretora efetiva;
 * super-admin precisa ter "entrado" numa corretora). A senha trafega só no PUT
 * (TLS) e nunca volta ao front. O "Testar" reusa /api/segfy/credenciais/testar.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirAdmin, exigirCorretoraSelecionada } from "../../middlewares/authSupabase";
import { logger } from "../../utils/logger";
import { obterSetup, salvarProdutos, salvarSistema } from "./setup.service";
import { SISTEMAS_PUBLICOS, SISTEMA_PADRAO, sistemaValido } from "../quote/sistemas.catalog";

const router = Router();

const sistemaSchema = z.object({
  // Aceita qualquer sistema do catálogo único (sem enum fixo → N sistemas).
  sistema: z
    .string()
    .trim()
    .default(SISTEMA_PADRAO)
    .refine(sistemaValido, { message: "sistema de cotação desconhecido" }),
  url: z.string().trim().url("URL inválida").max(300).nullish(),
  email: z.string().trim().email("e-mail inválido").max(254),
  senha: z.string().min(1, "senha obrigatória").max(200),
});

const produtosSchema = z.object({
  ramos: z.array(z.enum(["auto", "residencial", "vida", "empresarial", "saude"])).max(10),
});

// Catálogo público de sistemas de cotação (popula o select do front + capacidade
// `exige2fa`). Não expõe nada sensível; basta admin. Sem escopo de corretora.
router.get("/sistemas", exigirAdmin, (_req: Request, res: Response) => {
  res.json({ ok: true, sistemas: SISTEMAS_PUBLICOS });
});

router.get("/", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  try {
    res.json({ ok: true, ...(await obterSetup(req.corretoraId!)) });
  } catch (e) {
    logger.error("[setup.routes] obter falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "get_failed", mensagem: (e as Error).message });
  }
});

router.put("/sistema", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const parsed = sistemaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    await salvarSistema(req.corretoraId!, {
      sistema: parsed.data.sistema,
      url: parsed.data.url ?? null,
      email: parsed.data.email,
      senha: parsed.data.senha,
      porEmail: req.user?.email ?? null,
    });
    res.json({ ok: true, ...(await obterSetup(req.corretoraId!)) });
  } catch (e) {
    logger.error("[setup.routes] salvar sistema falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "save_failed", mensagem: (e as Error).message });
  }
});

router.put("/produtos", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const parsed = produtosSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    await salvarProdutos(req.corretoraId!, parsed.data.ramos);
    res.json({ ok: true, ...(await obterSetup(req.corretoraId!)) });
  } catch (e) {
    logger.error("[setup.routes] salvar produtos falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "save_failed", mensagem: (e as Error).message });
  }
});

export const setupRouter = router;
