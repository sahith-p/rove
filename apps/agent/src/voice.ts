// Voice notes (docs/specs/voice.md). Owner: Saran · Tasks: SA-C1 (in), SA-C2 (out).
// In: ElevenLabs Speech-to-Text (scribe_v2). iMessage voice notes are usually CAF/AAC; CAF is converted to
// 16 kHz mono WAV with ffmpeg first, and any format STT rejects is converted and retried once.
// Out: ElevenLabs Text-to-Speech (eleven_flash_v2_5, mp3) → ffmpeg AAC in .m4a so iMessage shows a voice bubble.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Deps, Voice } from "./ports";

const run = promisify(execFile);

const API = "https://api.elevenlabs.io/v1";
const STT_MODEL = "scribe_v2";
const TTS_MODEL = "eleven_flash_v2_5";
const MAX_SPOKEN_CHARS = 220;

export function createVoice(deps: Deps): Voice {
  const { apiKey, voiceId } = deps.config.elevenLabs;

  async function stt(audio: Buffer, mimeType: string, name: string): Promise<string> {
    const form = new FormData();
    form.append("model_id", STT_MODEL);
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), name);
    const res = await fetch(`${API}/speech-to-text`, { method: "POST", headers: { "xi-api-key": apiKey }, body: form });
    if (!res.ok) throw new SttError(res.status, await res.text().catch(() => ""));
    const body = (await res.json()) as { text?: string };
    return (body.text ?? "").trim();
  }

  return {
    async transcribe(audio, mimeType) {
      if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");
      if (isCaf(mimeType)) return stt(await toWav(audio, extensionFor(mimeType)), "audio/wav", "voice.wav");
      try {
        return await stt(audio, mimeType, `voice.${extensionFor(mimeType)}`);
      } catch (err) {
        if (!(err instanceof SttError) || err.status >= 500) throw err;
        deps.log("voice: STT rejected", mimeType, "→ converting to wav", err.status);
        return stt(await toWav(audio, extensionFor(mimeType)), "audio/wav", "voice.wav");
      }
    },

    async speak(text) {
      if (!apiKey || !voiceId) return null;
      const spoken = speakable(shorten(text));
      if (!spoken) return null;
      const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: spoken, model_id: TTS_MODEL }),
      });
      if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${await res.text().catch(() => "")}`);
      const mp3 = Buffer.from(await res.arrayBuffer());
      const { audio, duration } = await toM4a(mp3);
      return { audio, mimeType: "audio/mp4", name: "reply.m4a", ...(duration !== undefined ? { duration } : {}) };
    },
  };
}

class SttError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`ElevenLabs STT ${status}: ${body.slice(0, 200)}`);
  }
}

function isCaf(mimeType: string): boolean {
  return /caf/i.test(mimeType);
}

function extensionFor(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("caf")) return "caf";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("amr")) return "amr";
  return "bin";
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "rove-voice-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Any audio → 16 kHz mono WAV (what STT accepts most reliably). */
async function toWav(audio: Buffer, ext: string): Promise<Buffer> {
  return withTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    const output = join(dir, "out.wav");
    await writeFile(input, audio);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", output]);
    return readFile(output);
  });
}

/** mp3 → AAC in .m4a (iMessage voice bubble), plus its duration in seconds when ffprobe is available. */
async function toM4a(mp3: Buffer): Promise<{ audio: Buffer; duration?: number }> {
  return withTemp(async (dir) => {
    const input = join(dir, "reply.mp3");
    const output = join(dir, "reply.m4a");
    await writeFile(input, mp3);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-c:a", "aac", "-b:a", "64k", output]);
    const audio = await readFile(output);
    let duration: number | undefined;
    try {
      const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", output]);
      const secs = Number.parseFloat(stdout.trim());
      if (Number.isFinite(secs)) duration = Math.round(secs * 10) / 10;
    } catch {
      // ffprobe missing: duration is optional
    }
    return { audio, ...(duration !== undefined ? { duration } : {}) };
  });
}

/** Keep spoken replies short (~12 s): first two sentences, capped at MAX_SPOKEN_CHARS. */
function shorten(text: string): string {
  const clean = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  const sentences = clean.match(/[^.!?]+[.!?]*/g) ?? [clean];
  let out = sentences.slice(0, 2).join(" ").trim();
  if (out.length > MAX_SPOKEN_CHARS) {
    const cut = out.slice(0, MAX_SPOKEN_CHARS);
    out = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trim()}.`;
  }
  return out;
}

/**
 * Text → something TTS reads naturally. Amounts: "S$12.50" → "12 dollars 50", "S$5.00" → "5 dollars",
 * "US$3.20" → "3 US dollars 20". Strips emoji and symbols TTS would read out loud.
 */
export function speakable(text: string): string {
  return text
    .replace(/(US|S)\$\s?(\d[\d,]*)(?:\.(\d{1,2}))?/g, (_m, cur: string, whole: string, cents?: string) => {
      const dollars = whole.replace(/,/g, "");
      const unit = cur === "US" ? (dollars === "1" ? "US dollar" : "US dollars") : dollars === "1" ? "dollar" : "dollars";
      const c = cents ? cents.padEnd(2, "0") : "";
      return c && c !== "00" ? `${dollars} ${unit} ${c}` : `${dollars} ${unit}`;
    })
    .replace(/••••/g, "ending ")
    .replace(/[✓✔]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
