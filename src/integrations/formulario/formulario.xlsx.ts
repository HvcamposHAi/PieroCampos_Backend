/**
 * Geração e parsing do questionário Excel (.xlsx) — funções PURAS, em memória.
 *
 * Layout da aba "Questionário":
 *   A (oculta) = chave do roteiro    (usada no parse — robusto a reordenação)
 *   B          = Pergunta (rótulo)
 *   C          = Obrigatório         ("Sim" / "")
 *   D          = Dica
 *   E          = Resposta            (vazia; o cliente preenche)
 *
 * Aba "_meta" (veryHidden): A1=FORM_MAGIC, B1=categoria, C1=versão. É o que
 * permite reconhecer, na volta, que o arquivo é um questionário nosso e de qual
 * categoria — sem confiar no nome do arquivo (que o cliente pode renomear).
 *
 * Defesa: o parse nunca lança. Buffer inválido / sem marcador → retorna null.
 */
import ExcelJS from "exceljs";
import type { CategoriaConversa } from "../../lib/roteiros";
import { getRoteiro, CHAVES_VALIDAS } from "../../lib/roteiros";
import { logger } from "../../utils/logger";
import {
  ABA_META,
  ABA_QUESTIONARIO,
  FORM_MAGIC,
  FORM_VERSAO,
  type RespostaFormulario,
} from "./formulario.types";

const COL_CHAVE = 1; // A
const COL_PERGUNTA = 2; // B
const COL_OBRIGATORIO = 3; // C
const COL_DICA = 4; // D
const COL_RESPOSTA = 5; // E
const PRIMEIRA_LINHA_CAMPO = 2; // linha 1 é cabeçalho

/**
 * Gera o questionário .xlsx para a categoria. Uma linha por campo do roteiro.
 * Lança se a categoria não tiver roteiro (chamador só usa renovacao/seguro_novo).
 */
export async function gerarQuestionarioXlsx(categoria: CategoriaConversa): Promise<Buffer> {
  const roteiro = getRoteiro(categoria);
  if (!roteiro) {
    throw new Error(`gerarQuestionarioXlsx: categoria sem roteiro: ${categoria}`);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Piero de Campos Seguros";

  const ws = wb.addWorksheet(ABA_QUESTIONARIO);
  ws.columns = [
    { key: "chave", width: 10, hidden: true },
    { key: "pergunta", width: 42 },
    { key: "obrigatorio", width: 12 },
    { key: "dica", width: 48 },
    { key: "resposta", width: 32 },
  ];

  // Cabeçalho.
  const header = ws.getRow(1);
  header.getCell(COL_CHAVE).value = "chave";
  header.getCell(COL_PERGUNTA).value = "Pergunta";
  header.getCell(COL_OBRIGATORIO).value = "Obrigatório";
  header.getCell(COL_DICA).value = "Dica";
  header.getCell(COL_RESPOSTA).value = "Resposta";
  header.font = { bold: true };

  let linha = PRIMEIRA_LINHA_CAMPO;
  for (const campo of roteiro.campos) {
    const row = ws.getRow(linha);
    row.getCell(COL_CHAVE).value = campo.chave;
    row.getCell(COL_PERGUNTA).value = campo.rotulo;
    row.getCell(COL_OBRIGATORIO).value = campo.obrigatorio ? "Sim" : "";
    row.getCell(COL_DICA).value = campo.dica ?? "";
    row.getCell(COL_RESPOSTA).value = "";
    linha++;
  }

  // Aba de metadados — proveniência. veryHidden p/ não aparecer ao cliente.
  const meta = wb.addWorksheet(ABA_META, { state: "veryHidden" });
  meta.getCell("A1").value = FORM_MAGIC;
  meta.getCell("B1").value = categoria;
  meta.getCell("C1").value = FORM_VERSAO;

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}

/** Lê o valor de uma célula como string trimada (resolve rich-text/fórmula). */
function celulaTexto(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
  // Rich text.
  if (typeof v === "object" && "richText" in v && Array.isArray((v as ExcelJS.CellRichTextValue).richText)) {
    return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("").trim();
  }
  // Fórmula com resultado.
  if (typeof v === "object" && "result" in v) {
    const r = (v as ExcelJS.CellFormulaValue).result;
    return r == null ? "" : String(r).trim();
  }
  return String(v).trim();
}

/**
 * Parseia um .xlsx devolvido pelo cliente. Retorna `null` se não for um
 * questionário nosso (sem marcador) ou se o buffer estiver corrompido.
 * Nunca lança. Só mantém chaves do roteiro (whitelist `CHAVES_VALIDAS`) e
 * descarta respostas vazias.
 */
export async function parseQuestionarioXlsx(buf: Buffer): Promise<RespostaFormulario | null> {
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch (e) {
    logger.warn("[formulario] xlsx ilegível", { erro: (e as Error).message });
    return null;
  }

  const meta = wb.getWorksheet(ABA_META);
  if (!meta) return null;
  const magic = celulaTexto(meta.getCell("A1"));
  if (magic !== FORM_MAGIC) return null;

  const categoria = celulaTexto(meta.getCell("B1")) as CategoriaConversa;
  const versaoStr = celulaTexto(meta.getCell("C1"));
  const versao = Number.parseInt(versaoStr, 10) || FORM_VERSAO;

  const ws = wb.getWorksheet(ABA_QUESTIONARIO);
  if (!ws) return null;

  const respostas: Record<string, string> = {};
  ws.eachRow((row, rowNumber) => {
    if (rowNumber < PRIMEIRA_LINHA_CAMPO) return; // pula cabeçalho
    const chave = celulaTexto(row.getCell(COL_CHAVE));
    if (!chave || !CHAVES_VALIDAS.has(chave)) return;
    const resposta = celulaTexto(row.getCell(COL_RESPOSTA));
    if (!resposta) return; // não preenchido
    respostas[chave] = resposta;
  });

  return { categoria, versao, respostas };
}
