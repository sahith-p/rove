// Mock CardPresenter (USE_MOCK_CARDS=1): logs instead of sending through Photon.
// Lets the agent and worker be built and evaluated before gate G2.

import type { CardPresenter } from "../cards";

export function createConsoleCardPresenter(log: (line: string) => void = console.log): CardPresenter {
  let n = 0;
  const known = new Set<string>();
  const id = () => `mock-msg-${++n}`;
  return {
    async send(to, spec) {
      known.add(spec.key);
      log(`[card:send] → ${to.channel}:${to.phone} ${spec.kind} ${spec.key} ${spec.url} | ${spec.fallbackText}`);
      return { messageId: id(), edited: false };
    },
    async update(to, spec) {
      const edited = known.has(spec.key);
      known.add(spec.key);
      log(`[card:${edited ? "edit" : "send"}] → ${to.channel}:${to.phone} ${spec.kind} ${spec.key} ${spec.url}`);
      return { messageId: id(), edited };
    },
    async text(to, body) {
      log(`[text] → ${to.channel}:${to.phone}: ${body}`);
      return { messageId: id() };
    },
    async image(to, png, name, caption) {
      log(`[image] → ${to.channel}:${to.phone}: ${name} (${png.byteLength} bytes)${caption ? ` "${caption}"` : ""}`);
      return { messageId: id() };
    },
  };
}
