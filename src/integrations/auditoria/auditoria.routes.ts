/**
 * Rotas de ACESSO da trilha de auditoria.
 *
 *   - POST /api/auditoria/acesso        → login/logout (AUTENTICADA: identidade
 *                                          verificada por JWT no authSupabase).
 *   - POST /api/auditoria/acesso-falho  → tentativa de login que falhou (PÚBLICA:
 *                                          o front reporta antes de ter JWT). Ator
 *                                          marcado como não-autenticado; rate-limit
 *                                          em memória evita flood de log.
 *
 * As MUTAÇÕES de negócio são auditadas pelo middleware `auditarMutacoes`; aqui
 * ficam só os eventos de acesso. A LEITURA da trilha é feita direto pelo front
 * via Supabase (RLS admin-only) — não há GET aqui.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { carregarOperadorAtivo } from "../../middlewares/authSupabase";
import { registrarAuditoria } from "./auditoria.service";

// --- Rotas AUTENTICADAS (montadas sob authSupabase) ---
const router = Router();

const acessoSchema = z.object({
  tipo: z.enum(["login", "logout"]),
  detalhe: z.record(z.string(), z.unknown()).optional(),
});

router.post("/acesso", async (req: Request, res: Response) => {
  const parsed = acessoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  // Resposta imediata; a gravação é best-effort e não bloqueia o cliente.
  res.json({ ok: true });

  const operador = await carregarOperadorAtivo(req);
  void registrarAuditoria({
    operadorId: operador?.id ?? null,
    atorEmail: req.user?.email ?? null,
    atorUserId: req.user?.id ?? null,
    categoria: "acesso",
    acao: parsed.data.tipo,
    sucesso: true,
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
    detalhe: parsed.data.detalhe ?? null,
  });
});

export const auditoriaRouter = router;

// --- Rota PÚBLICA (montada ANTES do gate, junto de /ping) ---
const publico = Router();

const acessoFalhoSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  motivo: z.string().trim().max(300).optional(),
});

/**
 * Rate-limit em memória: no máx. LIMITE eventos por IP dentro de JANELA_MS.
 * Suficiente para conter flood; reinicia a cada cold start do Render (aceitável).
 */
const JANELA_MS = 60_000;
const LIMITE = 10;
const baldes = new Map<string, { contagem: number; reiniciaEm: number }>();

function permitido(ip: string, agora: number): boolean {
  const balde = baldes.get(ip);
  if (!balde || agora >= balde.reiniciaEm) {
    baldes.set(ip, { contagem: 1, reiniciaEm: agora + JANELA_MS });
    return true;
  }
  if (balde.contagem >= LIMITE) return false;
  balde.contagem += 1;
  return true;
}

publico.post("/", async (req: Request, res: Response) => {
  const parsed = acessoFalhoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido" });
    return;
  }
  const ip = req.ip ?? "desconhecido";
  if (!permitido(ip, Date.now())) {
    res.status(429).json({ erro: "rate_limited" });
    return;
  }
  res.json({ ok: true });

  void registrarAuditoria({
    operadorId: null,
    atorEmail: parsed.data.email,
    atorUserId: null,
    categoria: "acesso",
    acao: "login_falho",
    sucesso: false,
    ip,
    userAgent: req.headers["user-agent"] ?? null,
    detalhe: parsed.data.motivo ? { motivo: parsed.data.motivo } : null,
  });
});

export const auditoriaPublicoRouter = publico;

/** Reseta o rate-limit (uso em testes). */
export function _resetRateLimitAuditoria(): void {
  baldes.clear();
}
