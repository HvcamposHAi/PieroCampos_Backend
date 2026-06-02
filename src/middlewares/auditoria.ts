/**
 * Middleware de auditoria de MUTAÇÕES.
 *
 * Para cada request de escrita (POST/PATCH/PUT/DELETE) que passou pelo
 * authSupabase, registra um evento em `auditoria_eventos` APÓS a resposta ser
 * enviada (`res.on("finish")`) — 100% fora do caminho da resposta, fire-and-forget.
 * Nunca altera a resposta nem aborta o fluxo: toda a gravação é não-fatal.
 *
 * Montagem em app.ts (por router, com a categoria correspondente):
 *   app.use("/api/usuarios", authSupabase, auditarMutacoes("usuarios"), usuariosRouter);
 */
import type { NextFunction, Request, Response } from "express";
import { carregarOperadorAtivo } from "./authSupabase";
import { registrarAuditoria, type CategoriaAuditoria } from "../integrations/auditoria/auditoria.service";

const METODOS_MUTACAO = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Remove query string e devolve os segmentos do path. */
function segmentos(originalUrl: string): string[] {
  const semQuery = originalUrl.split("?")[0] ?? "";
  return semQuery.split("/").filter(Boolean);
}

/** Primeiro segmento com cara de UUID = id do recurso alvo (quando houver). */
function extrairRecursoId(segs: string[]): string | null {
  return segs.find((s) => RE_UUID.test(s)) ?? null;
}

/**
 * Deriva uma `acao` legível do método + sufixo do path. Mantém um verbo
 * genérico por método e refina quando o último segmento é uma ação conhecida.
 */
export function derivarAcao(metodo: string, segs: string[]): string {
  const ultimo = (segs[segs.length - 1] ?? "").toLowerCase();
  const refino: Record<string, string> = {
    senha: "redefinir_senha",
    desativar: "desativar",
    disparar: "disparar_cotacao",
    enviar: "enviar_cotacao",
    responder: "enviar_mensagem",
    send: "enviar_mensagem",
    assumir: "assumir_conversa",
    devolver: "devolver_conversa",
    connect: "conectar_canal",
    disconnect: "desconectar_canal",
    "bot-ativo": "alternar_bot",
    "bia-gerar": "bia_gerar",
    "simular-cliente": "simular_cliente",
    "perguntar-campo": "perguntar_campo",
    "dados-coletados": "editar_dados",
    "cliente-cpf": "editar_cpf",
    "cliente-telefone": "editar_telefone",
    config: "salvar_config",
  };
  if (refino[ultimo]) return refino[ultimo]!;
  switch (metodo) {
    case "POST":
      return "criar";
    case "PATCH":
    case "PUT":
      return "atualizar";
    case "DELETE":
      return "excluir";
    default:
      return metodo.toLowerCase();
  }
}

export function auditarMutacoes(categoria: CategoriaAuditoria) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!METODOS_MUTACAO.has(req.method)) {
      next();
      return;
    }

    res.on("finish", () => {
      // Tudo aqui é best-effort; um erro de auditoria nunca pode vazar.
      void (async () => {
        try {
          const operador = await carregarOperadorAtivo(req);
          const segs = segmentos(req.originalUrl);
          await registrarAuditoria({
            operadorId: operador?.id ?? null,
            atorEmail: req.user?.email ?? null,
            atorUserId: req.user?.id ?? null,
            categoria,
            acao: derivarAcao(req.method, segs),
            recursoId: extrairRecursoId(segs),
            metodo: req.method,
            rota: (req.originalUrl.split("?")[0] ?? "").slice(0, 500),
            statusHttp: res.statusCode,
            sucesso: res.statusCode < 400,
            ip: req.ip ?? null,
            userAgent: req.headers["user-agent"] ?? null,
          });
        } catch {
          // registrarAuditoria já engole erros; este catch é só defesa extra.
        }
      })();
    });

    next();
  };
}
