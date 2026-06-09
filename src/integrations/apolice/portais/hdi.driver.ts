/**
 * Driver de EXEMPLO (HDI Seguros, grupo B_rpa) — modelo de como especializar um
 * portal. Parte do `genericoDriver` e sobrescreve só o que difere (URL de login,
 * seletores conhecidos, passos de navegação). Os seletores aqui são PLACEHOLDERS
 * tolerantes: ao habilitar a emissão para a HDI de verdade, ajustar contra o
 * portal real (em harness manual, NUNCA no CI). Demais portais seguem este molde.
 */
import { genericoDriver } from "./generico.driver";
import type { PortalDriver } from "./driver.port";

export const hdiDriver: PortalDriver = {
  ...genericoDriver,
  nome: "HDI Seguros",
  loginUrl: "https://portal.hdiseguros.com.br/login",
  seletores: {
    usuario: 'input[name="login"], input[name="usuario"], input[type="text"]',
    senha: 'input[name="senha"], input[type="password"]',
    submit: 'button[type="submit"], button:has-text("Entrar")',
  },
};
