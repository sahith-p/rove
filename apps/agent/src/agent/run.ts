// The Claude turn (agent.md §3): one toolRunner call with the persona's tools, plain-text history, refusal check.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaToolRunnerParams } from "@anthropic-ai/sdk/lib/tools/BetaToolRunner";
import { AGENT_MODEL } from "@rove/shared";
import type { ActionsService, Deps, OnboardingFlow, TurnInput, TurnResult, TurnRunner } from "../ports";
import type { ToolContext } from "../tools/context";
import { customerTools } from "../tools/customer";
import { merchantTools } from "../tools/merchant";
import { loadHistory, saveTurn } from "./history";
import { clockLine } from "../time";
import { plainText } from "./text";
import { customerPrompt, merchantPrompt } from "./prompts";

/** Text messages, not documents: drop markdown the model might still emit. */
export function createTurnRunner(deps: Deps, m: { actions: ActionsService; onboarding: OnboardingFlow }): TurnRunner {
  const client = deps.config.anthropicApiKey ? new Anthropic({ apiKey: deps.config.anthropicApiKey, defaultHeaders: deps.config.anthropicWorkspaceId ? { "anthropic-workspace-id": deps.config.anthropicWorkspaceId } : undefined }) : null;

  return {
    async turn(input: TurnInput): Promise<TurnResult> {
      const calls: TurnResult["toolCalls"] = [];
      const finish = async (reply: string, refused = false): Promise<TurnResult> => {
        try {
          await saveTurn(deps.store, { persona: input.persona, from: input.from, merchant: input.merchant, user: input.text, assistant: reply });
        } catch (err) {
          deps.log("history save failed", err);
        }
        return { reply, toolCalls: calls, refused };
      };

      if (!client) {
        deps.log("turn skipped: ANTHROPIC_API_KEY is not set");
        return { reply: "I can't think right now (no ANTHROPIC_API_KEY set).", toolCalls: calls, refused: false };
      }

      const merchant = input.persona === "merchant" ? input.merchant : null;
      const ctx: ToolContext = { deps, from: input.from, merchant, actions: m.actions, onboarding: m.onboarding, calls };
      const tools = merchant ? [...merchantTools(ctx), ...customerTools(ctx)] : customerTools(ctx);
      const system = merchant ? merchantPrompt(merchant) : customerPrompt(input.from);
      const history = await loadHistory(deps.store, input.from.phone);
      const userText = `${clockLine(deps.now())}${input.voice ? " (voice note)" : ""} ${input.text}`;

      const params = {
        model: AGENT_MODEL,
        max_tokens: 16000,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        // Server-side retry on another model if a request is declined. The SDK types only know the array form.
        fallbacks: "default",
        system,
        tools,
        messages: [...history, { role: "user", content: userText }],
        max_iterations: 8,
      } as unknown as BetaToolRunnerParams;

      const started = Date.now();
      try {
        const final = await client.beta.messages.toolRunner(params);
        deps.log(`turn ${input.persona} ${Date.now() - started}ms tools=[${calls.map((c) => c.name).join(",")}] stop=${final.stop_reason}`);
        if (final.stop_reason === "refusal") return finish("Sorry, I can't help with that.", true);
        const text = final.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        return finish(plainText(text) || "Done.");
      } catch (err) {
        deps.log(`turn failed after ${Date.now() - started}ms`, err);
        if (err instanceof Anthropic.RateLimitError) return finish("I'm a bit busy right now. Try again in a minute?");
        if (err instanceof Anthropic.APIConnectionError) return finish("I couldn't reach my brain just now. Try again in a moment?");
        if (err instanceof Anthropic.APIError) return finish("Something went wrong on my side. Try again?");
        return finish("Something went wrong on my side. Try again?");
      }
    },
  };
}
