/**
 * Captura do estilo real do operador (fromMe humano). Garante que NÃO capturamos
 * nossas próprias mensagens (id na memória OU no banco) e que capturamos a digitação
 * humana com PII redigida. Best-effort: erros nunca propagam.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const fake = vi.hoisted(() => ({
  enviadas: [] as Array<{ twilio_message_sid?: string }>,
  inserted: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx: any = {
        select: () => ctx,
        eq: (col: string, val: string) => {
          if (col === "twilio_message_sid") {
            ctx._achou = fake.enviadas.find((m) => m.twilio_message_sid === val) ?? null;
          }
          return ctx;
        },
        limit: () => ctx,
        maybeSingle: () => Promise.resolve({ data: ctx._achou ?? null, error: null }),
        insert: (row: Record<string, unknown>) => {
          fake.inserted.push({ table, row });
          return Promise.resolve({ error: null });
        },
        _achou: null as unknown,
      };
      return ctx;
    },
  }),
}));

import {
  marcarEnvioProprio,
  capturarMensagemOperador,
  _resetIdsEnviados,
} from "../src/integrations/whatsapp/estilo-captura";

beforeEach(() => {
  fake.enviadas = [];
  fake.inserted = [];
  _resetIdsEnviados();
});

describe("capturarMensagemOperador", () => {
  it("captura digitação humana (id desconhecido) com PII redigida", async () => {
    await capturarMensagemOperador({ canalId: "c1", messageId: "HUMAN1", texto: "Bora resolver, CPF 123.456.789-09" });
    expect(fake.inserted).toHaveLength(1);
    expect(fake.inserted[0].table).toBe("operador_estilo_corpus");
    expect(fake.inserted[0].row.corpo).toContain("[cpf]");
    expect(fake.inserted[0].row.canal_id).toBe("c1");
  });

  it("NÃO captura mensagem nossa marcada em memória (anti-race)", async () => {
    marcarEnvioProprio("OURS1");
    await capturarMensagemOperador({ canalId: "c1", messageId: "OURS1", texto: "Mensagem da Bia" });
    expect(fake.inserted).toHaveLength(0);
  });

  it("NÃO captura mensagem nossa já persistida no banco", async () => {
    fake.enviadas = [{ twilio_message_sid: "OURS2" }];
    await capturarMensagemOperador({ canalId: "c1", messageId: "OURS2", texto: "Outra da Bia" });
    expect(fake.inserted).toHaveLength(0);
  });

  it("sem id confiável → não captura (evita poluir com texto da Bia)", async () => {
    await capturarMensagemOperador({ canalId: "c1", messageId: null, texto: "Sem id" });
    expect(fake.inserted).toHaveLength(0);
  });

  it("texto vazio/curto após redação → não captura", async () => {
    await capturarMensagemOperador({ canalId: "c1", messageId: "X", texto: " " });
    expect(fake.inserted).toHaveLength(0);
  });
});
