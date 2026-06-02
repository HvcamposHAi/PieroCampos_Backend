/**
 * Rotas HTTP de USUÁRIOS do portal (Admin → Operadores). Todas Admin-only.
 *   - GET   /api/usuarios            → lista (sem segredos).
 *   - POST  /api/usuarios            → cria login+senha e reconcilia operadores.
 *   - PATCH /api/usuarios/:id        → nome/perfil/ativo.
 *   - POST  /api/usuarios/:id/senha  → define/redefine senha (cria login se faltar).
 *   - POST  /api/usuarios/:id/desativar → soft delete (ativo=false).
 *
 * A senha trafega só no corpo (TLS) e nunca é logada. `exigirAdmin` é a defesa
 * real (não confiar na UI). Espelha o padrão de segfy/credenciais.routes.ts.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirAdmin, carregarOperadorAtivo } from "../../middlewares/authSupabase";
import { logger } from "../../utils/logger";
import {
  ErroUsuario,
  atualizarUsuario,
  criarUsuario,
  definirCanalPadrao,
  definirSenha,
  desativarUsuario,
  listarUsuarios,
} from "./usuarios.service";

const router = Router();

const perfilSchema = z.enum(["admin", "supervisor", "operador"]);
const senhaSchema = z.string().min(8, "A senha precisa de ao menos 8 caracteres.").max(72);

const criarSchema = z.object({
  nome: z.string().trim().min(2, "Informe o nome completo.").max(120),
  email: z.string().trim().toLowerCase().email("E-mail inválido.").max(254),
  perfil: perfilSchema,
  ativo: z.boolean(),
  senha: senhaSchema,
});

const patchSchema = z
  .object({
    nome: z.string().trim().min(2).max(120).optional(),
    perfil: perfilSchema.optional(),
    ativo: z.boolean().optional(),
  })
  .refine((v) => v.nome !== undefined || v.perfil !== undefined || v.ativo !== undefined, {
    message: "Nada para atualizar.",
  });

const senhaBodySchema = z.object({ senha: senhaSchema });

// Self-service (não admin): a linha que o operador opera na página móvel /bot.
const meCanalSchema = z.object({ canal_id: z.string().uuid().nullable() });

/** Mapeia erros de domínio para o status HTTP correto. */
function tratarErro(res: Response, contexto: string, e: unknown): void {
  if (e instanceof ErroUsuario) {
    const status = e.codigo === "nao_encontrado" ? 404 : 409;
    res.status(status).json({ erro: e.codigo, mensagem: e.message });
    return;
  }
  logger.error(`[usuarios.routes] ${contexto} falhou`, { erro: (e as Error).message });
  res.status(500).json({ erro: "erro_interno", mensagem: (e as Error).message });
}

router.get("/", exigirAdmin, async (_req: Request, res: Response) => {
  try {
    const usuarios = await listarUsuarios();
    res.json({ ok: true, usuarios });
  } catch (e) {
    tratarErro(res, "listar", e);
  }
});

router.post("/", exigirAdmin, async (req: Request, res: Response) => {
  const parsed = criarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const usuario = await criarUsuario({ ...parsed.data, porEmail: req.user?.email ?? null });
    res.status(201).json({ ok: true, usuario });
  } catch (e) {
    tratarErro(res, "criar", e);
  }
});

router.patch("/:id", exigirAdmin, async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ erro: "id_obrigatorio" });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const usuario = await atualizarUsuario({ operadorId: id, ...parsed.data });
    res.json({ ok: true, usuario });
  } catch (e) {
    tratarErro(res, "atualizar", e);
  }
});

router.post("/:id/senha", exigirAdmin, async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ erro: "id_obrigatorio" });
    return;
  }
  const parsed = senhaBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const r = await definirSenha({ operadorId: id, senha: parsed.data.senha });
    res.json({ ok: true, criouLogin: r.criouLogin });
  } catch (e) {
    tratarErro(res, "definir_senha", e);
  }
});

router.post("/:id/desativar", exigirAdmin, async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ erro: "id_obrigatorio" });
    return;
  }
  try {
    const usuario = await desativarUsuario(id);
    res.json({ ok: true, usuario });
  } catch (e) {
    tratarErro(res, "desativar", e);
  }
});

/**
 * SELF-SERVICE (operador ativo, NÃO admin): grava a linha que o próprio operador
 * opera (página móvel /bot). Só toca a própria row (id resolvido do JWT). Base do
 * escopo do toggle em /api/wa/canais/:id/bot-ativo (operador só a sua linha).
 */
router.put("/me/canal", async (req: Request, res: Response) => {
  const op = await carregarOperadorAtivo(req);
  if (!op) {
    res.status(403).json({ erro: "operador_required" });
    return;
  }
  const parsed = meCanalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const r = await definirCanalPadrao({ operadorId: op.id, canalId: parsed.data.canal_id });
    res.json({ ok: true, canal_padrao_id: r.canal_padrao_id });
  } catch (e) {
    tratarErro(res, "definir_canal", e);
  }
});

export const usuariosRouter = router;
