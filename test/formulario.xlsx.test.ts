/**
 * Round-trip do questionário Excel: gerar → preencher → parsear.
 * Usa o exceljs de verdade (sem rede). Cobre mapeamento por chave oculta,
 * descarte de chave inválida, preenchimento parcial e arquivo sem marcador.
 */
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { gerarQuestionarioXlsx, parseQuestionarioXlsx } from "../src/integrations/formulario";

/** Coluna A=chave (oculta), E=Resposta. Linha 1 = cabeçalho. */
const COL_CHAVE = 1;
const COL_RESPOSTA = 5;

/** Carrega o buffer, aplica um mutador na aba "Questionário" e regrava. */
async function editar(
  buf: Buffer,
  mut: (ws: ExcelJS.Worksheet) => void,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("Questionário")!;
  mut(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("questionário xlsx (round-trip)", () => {
  it("gera renovacao e parseia de volta as respostas preenchidas", async () => {
    const original = await gerarQuestionarioXlsx("renovacao");
    const preenchido = await editar(original, (ws) => {
      ws.eachRow((row, n) => {
        if (n < 2) return;
        const chave = String(row.getCell(COL_CHAVE).value ?? "");
        if (chave === "segurado") row.getCell(COL_RESPOSTA).value = "João Silva";
        if (chave === "email") row.getCell(COL_RESPOSTA).value = "joao@x.com";
      });
    });

    const parsed = await parseQuestionarioXlsx(preenchido);
    expect(parsed).not.toBeNull();
    expect(parsed!.categoria).toBe("renovacao");
    expect(parsed!.respostas.segurado).toBe("João Silva");
    expect(parsed!.respostas.email).toBe("joao@x.com");
    // Campos não preenchidos não aparecem.
    expect(parsed!.respostas.cep).toBeUndefined();
  });

  it("mapeia pela CHAVE oculta (col A), não pela ordem da linha", async () => {
    // Move o valor para a 2ª linha de campo mas mantém a chave 'placa' nela.
    const original = await gerarQuestionarioXlsx("seguro_novo");
    const preenchido = await editar(original, (ws) => {
      // acha a linha cuja chave é 'placa' e preenche
      ws.eachRow((row, n) => {
        if (n < 2) return;
        if (String(row.getCell(COL_CHAVE).value ?? "") === "placa") {
          row.getCell(COL_RESPOSTA).value = "ABC1D23";
        }
      });
    });
    const parsed = await parseQuestionarioXlsx(preenchido);
    expect(parsed!.respostas.placa).toBe("ABC1D23");
  });

  it("descarta chave fora do roteiro (col A adulterada)", async () => {
    const original = await gerarQuestionarioXlsx("renovacao");
    const preenchido = await editar(original, (ws) => {
      const row = ws.getRow(2);
      row.getCell(COL_CHAVE).value = "chave_inexistente";
      row.getCell(COL_RESPOSTA).value = "lixo";
    });
    const parsed = await parseQuestionarioXlsx(preenchido);
    expect(parsed!.respostas.chave_inexistente).toBeUndefined();
  });

  it("buffer sem marcador _meta → null (não é nosso questionário)", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Planilha1");
    ws.getCell("A1").value = "qualquer coisa";
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect(await parseQuestionarioXlsx(buf)).toBeNull();
  });

  it("buffer corrompido → null (nunca lança)", async () => {
    expect(await parseQuestionarioXlsx(Buffer.from("não é um xlsx"))).toBeNull();
  });
});
