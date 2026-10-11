// Agent service (port 4002). Owner: Saran. Spec: docs/specs/agent.md, docs/specs/onboarding.md, docs/specs/channels.md
//  - Spectrum runtime: iMessage + WhatsApp Business (+ terminal when USE_TERMINAL_PROVIDER=1)       SA-A1
//  - Persona routing: registered merchant phone → merchant agent; anyone else → customer agent      SA-A1
//  - Internal HTTP: /internal/events, /internal/actions/:id/confirm                                  SA-A2
//  - Pending actions: create / expire / confirm (👍 tapback, YES reply, card, web)                    SA-A3
//  - Onboarding over chat + iMessage App cards (setup, bank), polls, contact card, confetti          SA-A4
//  - Claude tool loop + merchant/customer tools                                                      SA-B1..B4
//  - Voice notes (ElevenLabs), contact cards in, invoice reminders                                   SA-C1..C4
// Outbound cards go through Sahith's CardPresenter (@rove/imessage-apps), injected with this process's Spectrum instance.

console.log("agent: not implemented yet (SA-A1)");
