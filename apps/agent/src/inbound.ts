// Routes one inbound message (agent.md §1): 👍 tapback → confirm · poll vote → onboarding · contact card →
// merchant contacts · voice → transcribe, then the text path, replying by voice too · YES → confirm ·
// a bare payment code → pay card without Claude · onboarding → the onboarding flow · else → a Claude turn.
// The runtime dedupes before calling; evals call this directly with a recording ReplyChannel.

import { PAYMENT_CODE_RE, type Recipient } from "@rove/shared";
import type { Agent } from "./app";
import { addContactFromCard } from "./contacts";
import { resolvePersona, shouldStartOnboarding } from "./personas";
import type { Inbound, ReplyChannel } from "./ports";
import { payCodeFastPath } from "./tools/customer";

const SORRY = "Sorry, something went wrong on my side. Try again in a moment.";
const LIKE = new Set(["👍", "like", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"]);

export async function handleInbound(agent: Agent, from: Recipient, msg: Inbound, reply: ReplyChannel): Promise<void> {
  try {
    await route(agent, from, msg, reply);
  } catch (err) {
    agent.deps.log("inbound failed", from.phone, msg.type, err);
    await reply.text(SORRY).catch(() => undefined);
  }
}

async function route(agent: Agent, from: Recipient, msg: Inbound, reply: ReplyChannel): Promise<void> {
  const { deps } = agent;
  switch (msg.type) {
    case "reaction":
      if (LIKE.has(msg.emoji.trim().toLowerCase()) || LIKE.has(msg.emoji.trim())) {
        await agent.actions.confirmByMessageId(msg.targetMessageId, from);
      }
      return;
    case "poll_option":
      if (msg.selected) await agent.onboarding.vote(from, msg.title);
      return;
    case "contact": {
      const { merchant } = await resolvePersona(deps.store, from);
      if (merchant?.status === "live") await reply.text(await addContactFromCard(deps, merchant, msg));
      else await reply.text("Thanks! Contact cards are for shops saving their customers. Text \"start a shop\" to open one.");
      return;
    }
    case "voice":
      await reply.responding(async () => {
        const text = (await agent.voice.transcribe(msg.audio, msg.mimeType)).trim();
        if (!text) {
          await reply.text("Sorry, I couldn't hear that voice note. Could you try again or type it?");
          return;
        }
        deps.log("voice transcript", from.phone, JSON.stringify(text));
        await handleText(agent, from, text, reply, true);
      });
      return;
    case "text":
      await handleText(agent, from, msg.text, reply, false);
      return;
    default:
      deps.log("ignored inbound", msg.kind);
  }
}

/** The text path, shared by typed messages and voice transcripts. */
export async function handleText(agent: Agent, from: Recipient, text: string, reply: ReplyChannel, voice: boolean): Promise<void> {
  const { deps } = agent;
  const { persona, merchant } = await resolvePersona(deps.store, from);

  if (merchant && persona === "merchant" && /^\s*yes\s*[.!]*\s*$/i.test(text)) {
    if (await agent.actions.confirmLatest(merchant, from)) return;
  }

  if (PAYMENT_CODE_RE.test(text)) {
    const answer = await payCodeFastPath(
      { deps, from, merchant: persona === "merchant" ? merchant : null, actions: agent.actions, onboarding: agent.onboarding },
      from,
      text.trim().toUpperCase(),
    );
    if (answer) await reply.text(answer);
    return;
  }

  if (persona === "onboarding") {
    await reply.responding(() => agent.onboarding.handle(from, text));
    return;
  }

  if (persona === "customer" && (await shouldStartOnboarding(deps.store, from, text))) {
    await agent.onboarding.start(from);
    return;
  }

  const result = await reply.responding(() =>
    agent.turns.turn({ persona: persona === "merchant" ? "merchant" : "customer", from, merchant: persona === "merchant" ? merchant : null, text, voice }),
  );
  if (!result.reply) return;
  await reply.text(result.reply);
  if (voice) {
    const spoken = await agent.voice.speak(result.reply).catch((err) => {
      deps.log("tts failed", err);
      return null;
    });
    if (spoken) await deps.outbox.voice(from, spoken.audio, { name: spoken.name, mimeType: spoken.mimeType, duration: spoken.duration });
  }
}

/** A ReplyChannel that records what was sent (evals, tests). */
export function recordingReply(sent: string[], onText?: (body: string) => void): ReplyChannel {
  let n = 0;
  return {
    async text(body) {
      sent.push(body);
      onText?.(body);
      return { messageId: `reply-${++n}` };
    },
    responding: (fn) => fn(),
  };
}
