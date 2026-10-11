// Worker service (port 4001). Owner: Nithya. Specs: docs/specs/settlement-xrpl.md, docs/specs/withdrawals.md
// Routes (all require `authorization: Bearer ${INTERNAL_SECRET}`), schemas in @rove/shared api.ts:
//   POST  /internal/settle                         NI-C2
//   POST  /internal/refunds                        NI-C5
//   POST  /internal/withdrawals                    NI-C3 (create `requested`, no money moves)
//   POST  /internal/withdrawals/:id/execute        NI-C4 (the pipeline)
//   POST  /internal/merchants                      NI-C1 (SettlementEngine.createMerchantAccount → status live)
//   PATCH /internal/merchants/:id/auto-withdraw    NI-C4
// Background: settle poller + invoice expiry (NI-C2), reconciler (NI-C7), withdrawal pipeline + partner callbacks + nightly auto-withdraw (NI-C4),
//             BNB pay-in watcher (NI-C6), invoice expiry (NI-C2).
// Emits EventEnvelope → POST ${AGENT_URL}/internal/events after every state change.

console.log("worker: not implemented yet (NI-C1)");
