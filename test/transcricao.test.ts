/**
 * Testa o módulo de transcrição (lib/transcricao): a guarda pura `audioElegivel`,
 * o orquestrador `transcreverAudio` (flag/guardas/provider injetável, nunca lança)
 * e o provedor OpenAI (`transcritorOpenAI`) com axios mockado.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));
vi.mock("axios", () => ({ default: { post: mockPost } }));

import {
  audioElegivel,
  transcreverAudio,
  transcritorOpenAI,
  type TranscritorProvider,
} from "../src/lib/transcricao";
import { _resetEnvCache, getEnv } from "../src/config/env";

const AUDIO = Buffer.from("fake-ogg-bytes");

beforeEach(() => {
  // Mantém as demais integrações desligadas p/ o superRefine não exigir credenciais.
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  process.env.TRANSCRICAO_ENABLED = "true";
  process.env.TRANSCRICAO_API_KEY = "test-key";
  process.env.TRANSCRICAO_MODEL = "gpt-4o-mini-transcribe";
  delete process.env.TRANSCRICAO_PROVIDER;
  delete process.env.TRANSCRICAO_MAX_SEG;
  delete process.env.TRANSCRICAO_MAX_BYTES;
  _resetEnvCache();
  mockPost.mockReset();
});

describe("audioElegivel", () => {
  const base = { maxSeg: 300, maxBytes: 25 * 1024 * 1024 };
  it("aceita audio/ogg dentro dos limites", () => {
    expect(audioElegivel({ mimetype: "audio/ogg; codecs=opus", duracaoSeg: 8, bytes: 1000, ...base })).toEqual({ ok: true });
  });
  it("rejeita mimetype não suportado", () => {
    expect(audioElegivel({ mimetype: "image/png", bytes: 1000, ...base })).toEqual({ ok: false, motivo: "mimetype" });
  });
  it("rejeita duração acima do teto", () => {
    expect(audioElegivel({ mimetype: "audio/ogg", duracaoSeg: 301, bytes: 1000, ...base })).toEqual({ ok: false, motivo: "duracao" });
  });
  it("rejeita tamanho acima do teto", () => {
    expect(audioElegivel({ mimetype: "audio/ogg", bytes: base.maxBytes + 1, ...base })).toEqual({ ok: false, motivo: "tamanho" });
  });
  it("duração ausente não bloqueia (bytes ainda protege)", () => {
    expect(audioElegivel({ mimetype: "audio/ogg", bytes: 1000, ...base })).toEqual({ ok: true });
  });
});

describe("transcreverAudio (orquestrador)", () => {
  it("flag desligada → null e NÃO chama o provider", async () => {
    process.env.TRANSCRICAO_ENABLED = "false";
    _resetEnvCache();
    const provider = vi.fn();
    const r = await transcreverAudio({ audio: AUDIO, mimetype: "audio/ogg" }, { provider });
    expect(r).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });

  it("happy path: usa o provider injetado e devolve o texto com trim", async () => {
    const provider: TranscritorProvider = vi.fn(async () => ({ texto: "  olá quero um seguro  " }));
    const r = await transcreverAudio({ audio: AUDIO, mimetype: "audio/ogg", duracaoSeg: 8 }, { provider });
    expect(r).toEqual({ texto: "olá quero um seguro", idioma: undefined, duracaoSeg: 8 });
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({ audio: AUDIO, mimetype: "audio/ogg", apiKey: "test-key", model: "gpt-4o-mini-transcribe", idiomaHint: "pt" }),
    );
  });

  it("áudio inelegível (mimetype) → null sem chamar o provider", async () => {
    const provider = vi.fn();
    const r = await transcreverAudio({ audio: AUDIO, mimetype: "image/png" }, { provider });
    expect(r).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });

  it("provider lança → null (nenhum throw escapa)", async () => {
    const provider: TranscritorProvider = vi.fn(async () => {
      throw new Error("boom");
    });
    const r = await transcreverAudio({ audio: AUDIO, mimetype: "audio/ogg" }, { provider });
    expect(r).toBeNull();
  });

  it("transcrição só com espaços → null", async () => {
    const provider: TranscritorProvider = vi.fn(async () => ({ texto: "   " }));
    const r = await transcreverAudio({ audio: AUDIO, mimetype: "audio/ogg" }, { provider });
    expect(r).toBeNull();
  });

  it("flag ligada sem API key → boot falha (superRefine bloqueia)", () => {
    process.env.TRANSCRICAO_API_KEY = "";
    _resetEnvCache();
    expect(() => getEnv()).toThrow(/TRANSCRICAO_API_KEY/);
  });
});

describe("transcritorOpenAI (axios mockado)", () => {
  const args = { audio: AUDIO, mimetype: "audio/ogg; codecs=opus", apiKey: "k", model: "gpt-4o-mini-transcribe", idiomaHint: "pt" };
  it("status 200 → mapeia {text} para {texto}", async () => {
    mockPost.mockResolvedValueOnce({ status: 200, data: { text: "oi" } });
    const r = await transcritorOpenAI(args);
    expect(r).toEqual({ texto: "oi", idioma: "pt" });
    expect(mockPost).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.anything(),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer k" }) }),
    );
  });
  it("status 401 → null", async () => {
    mockPost.mockResolvedValueOnce({ status: 401, data: { error: "x" } });
    expect(await transcritorOpenAI(args)).toBeNull();
  });
  it("axios lança → null", async () => {
    mockPost.mockRejectedValueOnce(new Error("network"));
    expect(await transcritorOpenAI(args)).toBeNull();
  });
});
