// CardPresenter over Photon Spectrum, for merchants and customers. Owner: Sahith (task SH-B4). Spec: docs/specs/imessage-apps.md §5
// The agent runtime (Saran) creates the Spectrum instance and passes it in; this module only sends/edits.
//   iMessage: app(url, {live}) to send, edit(app(newUrl, {live}), original) to update in place.
//   WhatsApp: fallbackText + url as text; invoices to people outside the 24h window use the approved template.

import type { CardPresenter } from "@rove/shared";

export function createSpectrumCardPresenter(_spectrum: unknown): CardPresenter {
  throw new Error("not implemented: SH-B4");
}
