/**
 * Gate + resolução adaptativa de seletor de portal por LLM. Espelha
 * dynamic-mapper.service: efetivo = `PORTAL_MAPPER_ENABLED` (env) E o toggle
 * `portal_mapper_config.ativo` (DB, por corretora, cache 30s). FAIL-CLOSED: com o
 * gate off ou qualquer erro, devolve `null` → o driver usa os hints tolerantes
 * atuais (comportamento de hoje). Com o gate on: regra ATIVA (cache) → seletor;
 * miss → coleta candidatos da página, LLM escolhe, valida na página, grava
 * regra `pendente` (aprovação humana) e usa.
 *
 * `import type { Page }` (Playwright) é só tipo — este módulo roda no AGENTE local
 * (onde há navegador); o backend pode importá-lo sem puxar Chromium.
 */
import type { Page } from "playwright";
import { getEnv } from "../../../config/env";
import { getSupabaseAdmin } from "../../whatsapp/supabase";
import { logger } from "../../../utils/logger";
import { carregarRegrasPortal, persistirRegraPortalPendente } from "./portal-rule-cache";
import { escolherSeletorComLLM, type CandidatoElemento } from "./portal-selector.llm";

const TTL_MS = 30_000;
const _toggle = new Map<string, { valor: boolean; em: number }>();

/** Toggle por corretora (default global + override). FAIL-CLOSED → false. */
async function lerPortalMapperAtivo(corretoraId: string | null): Promise<boolean> {
  const ck = corretoraId ?? "_default_";
  const agora = Date.now();
  const cached = _toggle.get(ck);
  if (cached && agora - cached.em < TTL_MS) return cached.valor;
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("portal_mapper_config")
      .select("corretora_id, ativo")
      .or(corretoraId ? `corretora_id.is.null,corretora_id.eq.${corretoraId}` : "corretora_id.is.null");
    if (error) return false;
    const linhas = (data ?? []) as Array<{ corretora_id: string | null; ativo: boolean }>;
    const override = linhas.find((l) => l.corretora_id === corretoraId);
    const def = linhas.find((l) => l.corretora_id === null);
    const valor = (override ?? def)?.ativo ?? false;
    _toggle.set(ck, { valor, em: agora });
    return valor;
  } catch {
    return false;
  }
}

/** Coleta candidatos interativos via Locator API (Node-side, sem lib DOM): para
 *  cada elemento monta um seletor estável + descrição (sem PII). Limita a 40. */
async function coletarCandidatos(page: Page): Promise<CandidatoElemento[]> {
  try {
    const loc = page.locator("button, a[href], input, select, textarea, [role=button]");
    const total = Math.min(await loc.count(), 40);
    const out: CandidatoElemento[] = [];
    for (let i = 0; i < total; i++) {
      const el = loc.nth(i);
      const id = await el.getAttribute("id").catch(() => null);
      const name = await el.getAttribute("name").catch(() => null);
      const texto = ((await el.textContent().catch(() => "")) ?? "").trim().slice(0, 40);
      const tipo = (await el.getAttribute("type").catch(() => "")) ?? "";
      const placeholder = (await el.getAttribute("placeholder").catch(() => "")) ?? "";
      const seletor = id ? `#${id}` : name ? `[name="${name}"]` : texto ? `text=${texto}` : `:nth-match(*, ${i + 1})`;
      const descricao = `${tipo ? `[type=${tipo}] ` : ""}${texto} ${placeholder}`.trim() || seletor;
      out.push({ seletor, descricao });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve o seletor para uma ação no portal. Devolve o seletor (regra ativa ou
 * escolha do LLM validada na página) ou `null` (→ o driver usa seus hints).
 */
export async function resolverSeletor(input: {
  seguradora: string;
  acao: string;
  descricaoAcao: string;
  corretoraId: string | null;
  page: Page;
}): Promise<string | null> {
  if (!getEnv().PORTAL_MAPPER_ENABLED) return null;
  try {
    if (!(await lerPortalMapperAtivo(input.corretoraId))) return null;

    // 1) Regra ATIVA (cache) → usa direto se ainda existe na página.
    const regras = await carregarRegrasPortal(input.seguradora, input.corretoraId);
    const ativo = regras.get(input.acao);
    if (ativo && (await input.page.locator(ativo).count().catch(() => 0)) > 0) return ativo;

    // 2) Miss → LLM escolhe entre candidatos reais.
    const candidatos = await coletarCandidatos(input.page);
    if (candidatos.length === 0) return null;
    const escolha = await escolherSeletorComLLM({ acaoDescricao: input.descricaoAcao, candidatos });
    if (!escolha.seletor) return null;
    // Anti-alucinação: o seletor TEM que existir na página.
    if ((await input.page.locator(escolha.seletor).count().catch(() => 0)) === 0) return null;
    await persistirRegraPortalPendente({
      seguradora: input.seguradora,
      acao: input.acao,
      seletor: escolha.seletor,
      corretoraId: input.corretoraId,
      confianca: escolha.confianca,
    });
    return escolha.seletor;
  } catch (e) {
    logger.warn("[portal.mapper] resolverSeletor falhou; fallback p/ hints", { erro: (e as Error).message });
    return null;
  }
}

/** Apenas para testes: zera o cache do toggle. */
export function _resetPortalToggleCache(): void {
  _toggle.clear();
}
