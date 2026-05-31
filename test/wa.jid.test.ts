/**
 * Testes das conversões de endereço WhatsApp: jidParaE164 (inbound) e seu inverso
 * e164ParaJid (outbound do operador). Funções puras, sem rede.
 */
import { describe, it, expect } from "vitest";
import { jidParaE164, e164ParaJid } from "../src/integrations/whatsapp/persistence";

describe("e164ParaJid", () => {
  it("converte E.164 em JID de usuário", () => {
    expect(e164ParaJid("+5541999998888")).toBe("5541999998888@s.whatsapp.net");
  });

  it("ignora máscara/formatação e mantém só dígitos", () => {
    expect(e164ParaJid("+55 (41) 99999-8888")).toBe("5541999998888@s.whatsapp.net");
    expect(e164ParaJid("5541999998888")).toBe("5541999998888@s.whatsapp.net");
  });

  it("retorna null sem dígitos", () => {
    expect(e164ParaJid("")).toBeNull();
    expect(e164ParaJid("+")).toBeNull();
  });

  it("roundtrip com jidParaE164", () => {
    const e164 = "+5541999998888";
    const jid = e164ParaJid(e164);
    expect(jid).not.toBeNull();
    expect(jidParaE164(jid as string)).toBe(e164);
  });
});
