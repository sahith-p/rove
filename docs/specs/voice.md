# Spec · Voice notes (ElevenLabs)

Owner: **Saran** · Code: `apps/agent/src/voice.ts` · Tasks: SA-C1, SA-C2, SA-C3

## 1. Inbound voice note → text (SA-C1)

```ts
case "voice": {
  const audio = await message.content.read();                // Buffer; mimeType on message.content.mimeType
  const text = await stt(audio, message.content.mimeType);   // ElevenLabs Speech-to-Text (Scribe model)
  await turn(space, merchant, text, { replyWithVoice: true });
}
```
- Call ElevenLabs Speech-to-Text with the audio as a multipart file. Check the current model id in their docs at setup.
- iMessage voice notes are usually AAC/CAF. If STT rejects the format, convert with ffmpeg (`ffmpeg -i in.caf -ar 16000 -ac 1 out.wav`).

## 2. Reply as a voice note (SA-C2)

1. Text-to-Speech with `ELEVENLABS_VOICE_ID`, a low-latency model (Flash), output mp3.
2. Convert to AAC in an `.m4a` so iMessage shows a voice bubble: `ffmpeg -i reply.mp3 -c:a aac -b:a 64k reply.m4a`.
3. `space.send(voice(buffer, { name: "reply.m4a", mimeType: "audio/mp4", duration }))`. Photon downgrades to an audio attachment on platforms without voice notes.
4. Also send the text reply (accessibility + judges reading the screen).

**Test in the first hour:** does `audio/mp4` arrive as a playable voice bubble? Note the answer in `tasks/integration.md`.

## 3. Who gets voice

Merchants and customers both can send voice notes ("invoice Maya two chicken rice", "what do I owe?"). Reply by voice when the incoming message was voice; otherwise text.

## 4. Rules

- **Amounts and references come from tool results, never from the model's guess.** The agent's reply text is already grounded; TTS just reads it.
- Keep spoken replies under ~12 seconds (1–2 sentences).
- Daily recap at 21:00 (SA-C3): "Fourteen sales today, one hundred eighteen dollars forty, all in your bank."
