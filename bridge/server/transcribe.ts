// Telegram voice notes are OGG/Opus, which the OpenAI transcription endpoint
// accepts as-is. One short HTTPS call, so it stays on this machine.

const MODELS = ["gpt-4o-transcribe", "whisper-1"];

export async function transcribe(apiKey: string, audio: Buffer, filename: string, signal?: AbortSignal): Promise<string> {
  let lastError = "no model tried";
  for (const model of MODELS) {
    const form = new FormData();
    form.set("model", model);
    form.set("file", new Blob([new Uint8Array(audio)]), filename);
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
    const payload = (await response.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
    if (response.ok && typeof payload.text === "string") return payload.text.trim();
    lastError = `${model}: ${response.status} ${payload.error?.message ?? ""}`.trim();
    // Only an unknown model is worth retrying with the next one.
    if (response.status !== 404 && !/model/i.test(payload.error?.message ?? "")) break;
  }
  throw new Error(`transcription failed (${lastError})`);
}
