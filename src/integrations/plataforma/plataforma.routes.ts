/**
 * Rotas do SUPER-ADMIN de plataforma (onboarding de corretoras + "entrar" numa
 * corretora). TODAS gated por `exigirPlataforma` (defesa real; a UI é só
 * conveniência). Espelha o padrão de usuarios.routes.ts.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirPlataforma } from "../../middlewares/authSupabase";
import { logger } from "../../utils/logger";
import { ErroUsuario } from "../usuarios/usuarios.service";
import {
  ErroPlataforma,
  criarAdminCorretora,
  criarCorretora,
  definirCorretoraAtiva,
  listarCorretoras,
} from "./plataforma.service";

const router = Router();

const criarCorretoraSchema = z.object({
  nome: z.string().trim().min(2, "Informe o nome da corretora.").max(120),
  slug: z.string().trim().min(2).max(60).regex(/^[a-z0-9-]+$/, "Slug: minúsculas, números e hífen.").optional(),
  plano: z.string().trim().max(40).optional(),
});

const criarAdminSchema = z.object({
  nome: z.string().trim().min(2, "Informe o nome completo.").max(120),
  email: z.string().trim().toLowerCase().email("E-mail inválido.").max(254),
  senha: z.string().min(8, "A senha precisa de ao menos 8 caracteres.").max(72),
});

const corretoraAtivaSchema = z.object({ corretora_id: z.string().uuid().nullable() });

function tratarErro(res: Response, contexto: string, e: unknown): void {
  if (e instanceof ErroPlataforma) {
    const status = e.codigo === "nao_encontrado" ? 404 : 409;
    res.status(status).json({ erro: e.codigo, mensagem: e.message });
    return;
  }
  if (e instanceof ErroUsuario) {
    const status = e.codigo === "nao_encontrado" ? 404 : 409;
    res.status(status).json({ erro: e.codigo, mensagem: e.message });
    return;
  }
  logger.error(`[plataforma.routes] ${contexto} falhou`, { erro: (e as Error).message });
  res.status(500).json({ erro: "erro_interno", mensagem: (e as Error).message });
}

router.get("/corretoras", exigirPlataforma, async (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, corretoras: await listarCorretoras() });
  } catch (e) {
    tratarErro(res, "listar", e);
  }
});

router.post("/corretoras", exigirPlataforma, async (req: Request, res: Response) => {
  const parsed = criarCorretoraSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const corretora = await criarCorretora(parsed.data);
    res.status(201).json({ ok: true, corretora });
  } catch (e) {
    tratarErro(res, "criar_corretora", e);
  }
});

router.post("/corretoras/:id/admin", exigirPlataforma, async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ erro: "id_obrigatorio" });
    return;
  }
  const parsed = criarAdminSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const usuario = await criarAdminCorretora({
      corretoraId: id,
      ...parsed.data,
      porEmail: req.user?.email ?? null,
    });
    res.status(201).json({ ok: true, usuario });
  } catch (e) {
    tratarErro(res, "criar_admin", e);
  }
});

router.put("/corretora-ativa", exigirPlataforma, async (req: Request, res: Response) => {
  const parsed = corretoraAtivaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const r = await definirCorretoraAtiva({
      operadorId: req.operador!.id,
      corretoraId: parsed.data.corretora_id,
    });
    res.json({ ok: true, ...r });
  } catch (e) {
    tratarErro(res, "corretora_ativa", e);
  }
});

export const plataformaRouter = router;
