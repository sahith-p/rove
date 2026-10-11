# Tasks: how this works

Three people, each running up to **three Claude Code agents in parallel** (one per lane), plus themselves as reviewer and integrator.

| File | Owner | Covers |
|---|---|---|
| [`sahith.md`](sahith.md) | Sahith | Minimal web app (pay, setup, bank, withdrawal, shop pages) · iMessage App cards (Photon App API) · QR images · Privy button · demo |
| [`nithya.md`](nithya.md) | Nithya | Money: DB, Stripe, XRPL settlement, ledger, withdrawal pipeline, BNB pay-in, worker |
| [`saran.md`](saran.md) | Saran | The agent: Photon runtime (iMessage + WhatsApp), merchant + customer tools, onboarding, confirmations, voice, evals |
| [`integration.md`](integration.md) | everyone (append-only) | Gate log, cross-owner requests, first-hour experiment results |

## Lanes

- Each person has **Lane A, B and C**. Tasks inside a lane run **top to bottom**; lanes run **in parallel**.
- Lanes touch **disjoint paths**, so agents in different lanes don't conflict. Every task lists its paths.
- **H** tasks are for the human (accounts, devices, reviews, gate checks), not an agent.

## Status markers (edit only your own file)

`[ ]` todo · `[~] <branch>` in progress · `[x]` merged · `[!] <reason>` blocked

## Starting an agent on a lane

```bash
git worktree add ../rove-<ID> -b <name>/<ID>-<slug>
cd ../rove-<ID>
claude "You are working on task <ID> in tasks/<name>.md. Read CLAUDE.md, then the files in that task's Spec line.
Only edit the task's Paths. Build against packages/shared contracts; use mocks where the task says so.
When done: run pnpm check, mark the task [x] in tasks/<name>.md, and open a PR titled '<ID> · <title>'."
```
When the PR merges, start the next unchecked task in that lane from a fresh worktree off `main`.

## Rules of thumb

- If a task takes more than **1.5× its budget**, stop, write what's blocking in `integration.md`, and ask a teammate.
- Merge at least every 45 minutes per lane. Small PRs merge cleanly.
- Never start a task whose **Depends** isn't merged. Pick another lane's next task instead.
- Times are targets for a hacking window of 11:30–17:15 with submission by 17:00.
