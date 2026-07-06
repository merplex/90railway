# Security TODO — API Authentication Gaps

Found 2026-07-06. Not yet fixed — implement later.

## Problem

Several endpoints in `index.js` have no authentication. They're public HTTP
endpoints on Railway, so anyone (e.g. via Postman/curl) can call them directly
and bypass the intended hardware/LIFF flow entirely.

### 1. `/api/generate-point-token` and `/create-qr`
Meant to be called only by the ESP32/HMI machine after a real cash payment.
No API key / secret / IP check — anyone can POST `{ amount }` and get back a
valid, unused point token without paying anything.

### 2. `/liff/consume`
Takes `token` + `userId` as plain query params. Never verifies that the
caller is actually the authenticated LINE user for that `userId` (no LIFF
ID token / access token verification against LINE's servers). Combined with
#1, someone can generate their own token and consume it into any account,
completing the whole "pay -> earn points" loop with no real payment.

### 3. `/liff/redeem-execute` + `/machine/confirm`
`/machine/confirm` only takes a `log_id` (sequential auto-increment int,
easy to guess/enumerate) and deducts points with no check that the request
came from the real machine. An attacker who knows a victim's LINE user id
could create a pending redeem and confirm it themselves, draining the
victim's points without the washer ever running.

## Recommended fixes

1. ✅ DONE (2026-07-06): Added `requireMachineKey` middleware checking
   `x-machine-key` header against `process.env.ESP32_API_KEY` on
   `/api/generate-point-token`, `/create-qr`, `/machine/confirm`.
   Remember to set `ESP32_API_KEY` on Railway and configure the ESP32/HMI
   firmware (and Boss's curl script for `/create-qr`) to send that header.
2. For `/liff/consume`, verify the LINE ID token / access token against
   `https://api.line.me/oauth2/v2.1/verify` (or equivalent) instead of
   trusting the `userId` query param.
3. Shorten token lifetime (e.g. 2-5 minutes) and add rate limiting.
