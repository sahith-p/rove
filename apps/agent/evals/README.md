Agent evals (SA-B4). One JSON file per scripted conversation in `cases/`. `run.ts` replays each case in-process
(no Spectrum) through the production router (`src/inbound.ts`) on a fresh agent: memory store + mock worker +
recording outbox. It checks tool calls, replies, outbound sends and worker calls. See docs/06-testing.md §4.

```bash
pnpm --filter agent evals                          # all cases
pnpm --filter agent evals --only c03-code-fast-path  # one case (repeat --only for more)
```

Without `ANTHROPIC_API_KEY` (env or repo-root `.env`), only cases that never reach Claude run (`claudeCalled: false`
or `needsClaude: false`: payment-code fast paths, onboarding steps, contact cards). The rest print SKIP.
The run exits non-zero if any case fails. Re-run after every prompt change.

## Case format

```jsonc
{
  "id": "m02-invoice-maya",
  "description": "…",
  "as": "merchant" | "customer" | "stranger",        // demo merchant, demo customer (Maya), or +6590009999
  "needsClaude": false,                               // optional; default = !(expect.claudeCalled === false)
  "setup": {
    "addBank": true,                                  // DBS ••••1234, verified, default
    "createCode": { "amount": "6.50", "expired": false }, // one-time code → $code
    "invoiceCustomer": { "amount": "8.00" },          // open invoice to Maya → $invoiceCode
    "payInvoice": { "amount": "12.50" }               // paid invoice to Maya → $paymentId, $paidCode
  },
  "turns": [
    { "inbound": { "type": "text", "text": "pay $code" } },
    { "inbound": { "type": "voice", "transcript": "how much today?" } },
    { "inbound": { "type": "reaction", "emoji": "👍", "target": "$lastConfirm" } },
    { "inbound": { "type": "contact", "name": "Joe", "phones": ["+6591110000"], "note": null } },
    { "inbound": { "type": "poll_option", "title": "Drinks", "pollTitle": "What do you sell?" } },
    { "inbound": { "type": "web_confirm", "via": "web" } }  // confirm button / /w step-up on the latest open action
  ],
  "expect": {
    "tools": ["create_invoice"], "notTools": ["propose_withdrawal"],
    "toolInput": [{ "tool": "create_invoice", "match": { "to": { "contactName": "maya" } } }],  // partial, case-insensitive strings
    "replyMatches": ["12\\.50"], "replyNotMatches": ["123456789"],     // regexes over the sender's replies
    "textMatches": ["11\\.00"], "textNotMatches": [],                   // regexes over replies + every outbound send
    "sends": [{ "kind": "invoice", "to": "customer", "contains": "S$" }], "noSends": ["confirm"],
    "claudeCalled": false,
    "workerCalls": [{ "method": "executeWithdrawal", "count": 1 }]
  }
}
```

`$lastConfirm` is the most recent confirm/withdrawal card or "👍 …" text sent to the sender. Send kinds are matched
loosely against what `outbox.ts` records (`invoice` matches `invoice`, `card:invoice`, `card_invoice`).
