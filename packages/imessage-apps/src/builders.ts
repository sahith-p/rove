// Pure CardSpec builders for all 9 card kinds. Owner: Sahith (task SH-B1). Spec: docs/specs/imessage-apps.md §3
// URL from `links(PUBLIC_BASE_URL)` + `v=<state>` (changes whenever the visible state changes, so iMessage refetches).

import type { CardBuilders } from "@rove/shared";

export function createCardBuilders(_opts: { baseUrl: string }): CardBuilders {
  throw new Error("not implemented: SH-B1");
}
