// Gate G2 smoke test. Owner: Sahith (SH-B4). Needs SPECTRUM_* + PUBLIC_BASE_URL + TOKEN_SECRET.
// 1. Spectrum({ providers: [imessage.config()] })
// 2. presenter.send(merchant, builders.setup({ merchant: DEMO_MERCHANT, menu: [], sessionToken }))
// 3. wait 5s  4. presenter.update(merchant, builders.setup({ ..., menu: DEMO_MENU }))  → the same bubble must change.
console.log("card-smoke: not implemented yet (SH-B4)");
