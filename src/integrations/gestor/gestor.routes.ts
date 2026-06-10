/**
 * Rotas do Copiloto (Admin › Copiloto). Admin-only e escopadas por corretora
 * EFETIVA (req.corretoraId). Gerenciam:
 *   - GET/PUT  /config            → toggle do recurso + sub-flags (pdf/gráfico)
 *   - GET/POST /autorizados       → allowlist de números de gestores
 *   - PATCH/DELETE /autorizados/:id
 *   - POST     /simular {numero,texto} → testa o pipeline SEM WhatsApp (E2E/admin)
 *
 * `exigirAdmin` é a defesa real (não a UI). Toda escrita carrega corretora_id do
 * req — um admin não consegue mexer na allowlist de outra corretora.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirAdmin, exigirCorretoraSelecionada } from "../../middlewares/authSupabase";
import { getSupabaseAdmin } from "../whatsapp/supabase";
import { e164ParaJid } from "../whatsapp/persistence";
import { normalizarTelefoneBr } from "../../lib/telefone";
import { processarMensagemGestor } from "../../services/gestor/agente-gestor.service";
import { logger } from "../../utils/logger";

const router = Router();

// ─── Config (toggle do recurso) ────────────────────────────────────────────
router.get("/config", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("gestor_assist_config")
      .select("ativo, permite_pdf, permite_grafico")
      .eq("corretora_id", req.corretoraId!)
      .maybeSingle();
    if (error) throw error;
    res.json({
      ok: true,
      config: data ?? { ativo: false, permite_pdf: true, permite_grafico: true },
    });
  } catch (e) {
    logger.error("[gestor.routes] get config falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "get_failed", mensagem: (e as Error).message });
  }
});

const configSchema = z.object({
  ativo: z.boolean(),
  permite_pdf: z.boolean().optional(),
  permite_grafico: z.boolean().optional(),
});

router.put("/config", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const sb = getSupabaseAdmin();
    const { error } = await sb.from("gestor_assist_config").upsert(
      {
        corretora_id: req.corretoraId!,
        ativo: parsed.data.ativo,
        ...(parsed.data.permite_pdf != null ? { permite_pdf: parsed.data.permite_pdf } : {}),
        ...(parsed.data.permite_grafico != null ? { permite_grafico: parsed.data.permite_grafico } : {}),
        atualizado_em: new Date().toISOString(),
        atualizado_por: req.user?.email ?? null,
      },
      { onConflict: "corretora_id" },
    );
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    logger.error("[gestor.routes] put config falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "save_failed", mensagem: (e as Error).message });
  }
});

// ─── Allowlist de gestores ─────────────────────────────────────────────────
router.get("/autorizados", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("gestor_autorizado")
      .select("id, numero_e164, nome_exibicao, operador_id, ativo, criado_em")
      .eq("corretora_id", req.corretoraId!)
      .order("criado_em", { ascending: false });
    if (error) throw error;
    res.json({ ok: true, autorizados: data ?? [] });
  } catch (e) {
    logger.error("[gestor.routes] list autorizados falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "get_failed", mensagem: (e as Error).message });
  }
});

const novoAutorizadoSchema = z.object({
  numero: z.string().min(8),
  nome_exibicao: z.string().trim().max(120).nullish(),
  operador_id: z.string().uuid().nullish(),
});

router.post("/autorizados", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const parsed = novoAutorizadoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const e164 = normalizarTelefoneBr(parsed.data.numero);
  if (!e164) {
    res.status(422).json({ erro: "numero_invalido", mensagem: "Telefone BR inválido." });
    return;
  }
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("gestor_autorizado")
      .insert({
        corretora_id: req.corretoraId!,
        numero_e164: e164,
        nome_exibicao: parsed.data.nome_exibicao ?? null,
        operador_id: parsed.data.operador_id ?? null,
        ativo: true,
      })
      .select("id")
      .single();
    if (error) {
      // 23505 = unique_violation (número já cadastrado nesta corretora).
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ erro: "numero_duplicado", mensagem: "Número já está na allowlist." });
        return;
      }
      throw error;
    }
    res.json({ ok: true, id: (data as { id: string }).id });
  } catch (e) {
    logger.error("[gestor.routes] criar autorizado falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "save_failed", mensagem: (e as Error).message });
  }
});

const patchAutorizadoSchema = z.object({
  ativo: z.boolean().optional(),
  nome_exibicao: z.string().trim().max(120).nullish(),
});

router.patch("/autorizados/:id", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(422).json({ erro: "id_invalido" });
    return;
  }
  const parsed = patchAutorizadoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const sb = getSupabaseAdmin();
    const patch: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
    if (parsed.data.ativo != null) patch.ativo = parsed.data.ativo;
    if (parsed.data.nome_exibicao !== undefined) patch.nome_exibicao = parsed.data.nome_exibicao;
    // Escopo por corretora: um admin não altera linha de outra corretora.
    const { error } = await sb
      .from("gestor_autorizado")
      .update(patch)
      .eq("id", id.data)
      .eq("corretora_id", req.corretoraId!);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    logger.error("[gestor.routes] patch autorizado falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "save_failed", mensagem: (e as Error).message });
  }
});

router.delete("/autorizados/:id", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(422).json({ erro: "id_invalido" });
    return;
  }
  try {
    const sb = getSupabaseAdmin();
    const { error } = await sb
      .from("gestor_autorizado")
      .delete()
      .eq("id", id.data)
      .eq("corretora_id", req.corretoraId!);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    logger.error("[gestor.routes] delete autorizado falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "delete_failed", mensagem: (e as Error).message });
  }
});

// ─── Simular (teste sem WhatsApp) ──────────────────────────────────────────
const simularSchema = z.object({
  numero: z.string().min(8),
  texto: z.string().trim().min(1).max(2000),
});

router.post("/simular", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const parsed = simularSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const e164 = normalizarTelefoneBr(parsed.data.numero);
  if (!e164) {
    res.status(422).json({ erro: "numero_invalido" });
    return;
  }
  try {
    // canalId fictício de teste — o pipeline resolve a identidade pelo NÚMERO, não
    // pelo canal. enviar() é no-op (nada vai ao WhatsApp); a resposta volta no JSON.
    const respostas: string[] = [];
    const midias: Array<{ tipo: string; nome?: string; bytes: number; caption?: string }> = [];
    const resultado = await processarMensagemGestor({
      canalId: `simular:${req.corretoraId}`,
      jidRemoto: e164ParaJid(e164) ?? `${e164}@s.whatsapp.net`,
      telefoneReal: e164,
      textoGestor: parsed.data.texto,
      enviar: async (t) => {
        respostas.push(t);
      },
      enviarDocumento: async (doc) => {
        midias.push({ tipo: "document", nome: doc.fileName, bytes: doc.documento.length, caption: doc.caption });
      },
      enviarImagem: async (img) => {
        midias.push({ tipo: "image", bytes: img.imagem.length, caption: img.caption });
      },
    });
    res.json({ ok: true, ...resultado, respostas, midias });
  } catch (e) {
    logger.error("[gestor.routes] simular falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "simular_failed", mensagem: (e as Error).message });
  }
});

export const gestorRouter = router;
