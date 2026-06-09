/**
 * Resolve o driver de portal para uma seguradora. Ponto único onde se registra
 * "quem sabe navegar o portal de quem". Adicionar um portal = registrar aqui +
 * criar o `<seguradora>.driver.ts`. Sem driver específico → `genericoDriver`
 * (best-effort tolerante). A escolha é por `nome_display` (case-insensitive).
 */
import type { SeguradoraConfigRef } from "../apolice-provider.port";
import type { PortalDriver } from "./driver.port";
import { genericoDriver } from "./generico.driver";
import { hdiDriver } from "./hdi.driver";

const DRIVERS: PortalDriver[] = [hdiDriver];

export function resolverDriver(seg: SeguradoraConfigRef): PortalDriver {
  const alvo = seg.nomeDisplay.trim().toLowerCase();
  return DRIVERS.find((d) => d.nome.trim().toLowerCase() === alvo) ?? genericoDriver;
}
