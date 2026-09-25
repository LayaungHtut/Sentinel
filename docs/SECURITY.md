# Security

This document describes SENTINEL's security model as implemented. The last section lists what still depends on how you deploy it.

## Trust boundaries

```
Browser ──(cookie session, same origin)──► SENTINEL server ──(Bearer API key)──► AssemblyAI Voice Agent API
   │                                            │  ├─► PostgreSQL
   │  audio frames + typed text only            │  ├─► Twilio / SMTP / Slack / webhook (outbound)
   ▼                                            │  └─◄ Twilio delivery receipts (signed), sensor API (API key)
 microphone, speaker, UI                        └─◄ /ack/<token> (one-time links in notifications)
```

- **The browser is not trusted with evidence.** It streams microphone audio and plays agent audio through the voice relay (`/api/voice/relay`). The server holds the AssemblyAI WebSocket, stores every transcript and executes every tool call. A modified client cannot submit a "voice" transcript or a voice-origin tool call.
- **The AssemblyAI API key never leaves the server.** No temporary token is issued to browsers either. The e2e suite and `scripts/live-browser.mjs` both assert that the browser never requests an AssemblyAI URL and that no request carries the key.

## Authentication and sessions

- Passwords: scrypt (N=16384, 64-byte key, random 16-byte salt), minimum 12 characters. Unknown emails still pay the scrypt cost, so response time does not reveal whether an account exists.
- Sessions: 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` on HTTPS). Only its SHA-256 is stored. 12-hour lifetime with sliding renewal. Changing a password signs out the user's other sessions. Disabled users are rejected on every request.
- First-run bootstrap (`/setup`) is available only until the first password account exists, and is serialised with an advisory lock.
- Demo sign-in (`DEMO_LOGIN_ENABLED`) is off by default and only ever grants access to the fictional demo organisation.
- API keys (sensors, integrations): `snt_` + 192 random bits, stored as SHA-256, shown once, revocable, with last-used tracking.
- CSRF: SvelteKit's origin check covers form posts. The voice WebSocket checks the `Origin` header against `ORIGIN`, or the request host.

## Authorisation

- **Tenancy:** every incident, contact, voice session, notification, attachment and API key belongs to an organisation. Every read and write goes through an org-scoped lookup. An incident from another organisation looks exactly like a missing one (404). Integration and e2e tests cover cross-org reads, writes and photo access.
- **Roles:** reporter < coordinator < manager < admin. Tool permissions are enforced in the executor, so they apply equally to voice, UI and API calls. A voice call runs with the role of the person speaking.

| Role        | Can                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| reporter    | report and add facts, confirm or doubt facts, track unknowns, add notes, record responses, generate reports  |
| coordinator | + actions, contact outreach, escalations, incident updates, play recordings                                  |
| manager     | + resolve escalations, close incidents, export, manage contacts                                              |
| admin       | + members and roles, response and retention policy, API keys, redaction, demo reset (demo organisation only) |

## Integrity: the audit trail

- Every timeline event is hash-chained per incident: `hash = SHA-256(canonical JSON of the event + previous hash)`, with a gap-free sequence. Writes are serialised with a transaction-scoped advisory lock.
- The **database itself** rejects `UPDATE`/`DELETE` on `timeline_events` and `tool_invocations`. It also rejects changes to a fact's evidence fields (value, basis, source, times) and deletion of facts. Supersession and verification state stay writable.
- `GET /api/incidents/:id/audit` (and the badge on every incident) re-verifies the chain from stored rows. An edit that bypasses the triggers, such as by a database superuser, is detected as a broken link or a sequence gap. See `production.integration.spec.ts`.
- Every tool call, successful or not, is logged with user, origin, arguments and outcome.

## Honesty guarantees

- Notifications use an outbox: they are queued inside the tool's transaction and sent only after commit. Statuses move `queued → sent → delivered | failed` only on provider responses or signed receipts. The agent is told exactly that state and nothing more.
- Twilio receipts are verified with `X-Twilio-Signature` (HMAC-SHA1 over the exact public URL). Generic webhooks carry `x-sentinel-signature: sha256=<HMAC>` when `NOTIFY_WEBHOOK_SECRET` is set.
- Acknowledgement links carry a one-time 192-bit token, stored hashed, that authorises only acknowledging that one message.
- Demo organisations never send anything. Everything there is labelled simulated.

## Privacy

- Voice starts only after the user accepts a recording/transcription notice (stored per user).
- `DATA_ENCRYPTION_KEY` enables AES-256-GCM encryption at rest for transcript text and evidence quotes.
- Retention: per-organisation `retentionDays` redacts transcript text and quotes (facts and the audit chain are kept). It can optionally delete AssemblyAI's stored session too (`DELETE /v1/sessions/{id}`).
- Admin redaction on request (`POST /api/incidents/:id/redact`) is recorded on the chain.
- Export (`GET /api/incidents/:id/export`, manager+) gives a complete machine-readable record for access requests or legal hold.
- Photos are type-checked by content (JPEG/PNG/WebP), limited to 5 MB, hashed and served only to the owning organisation with `Content-Security-Policy: default-src 'none'`.
- The service worker caches only the app shell. Incident data, transcripts and photos are never cached on the device.

## Hardening

- Strict Zod validation on every tool and API body. Unknown tools are rejected. JSON bodies are capped at 64 KB and relay frames at 256 KB.
- Rate limits are shared across instances (Postgres fixed window) and keyed per user, or per IP when anonymous. `RATE_LIMIT_SCALE` tunes them.
- Headers: HSTS on HTTPS, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (microphone and camera for this origin only).
- Errors return a request id, never internals. Logs are structured JSON and contain no secrets or transcript text.
- Voice cost controls: per-organisation concurrent-session and daily-minute caps, a 30-minute session cap, and `session.end` on every exit path, including shutdown.

## Your responsibility when deploying

- Run behind HTTPS and set `ORIGIN` / `PUBLIC_BASE_URL` to the public URL.
- Set `DATA_ENCRYPTION_KEY` and store it in a secret manager. Losing it makes encrypted text unreadable.
- Use managed PostgreSQL with backups and restrict network access to it.
- Protect `/api/metrics` with `METRICS_TOKEN` or network policy.
- Choose retention, consent wording and recording policy for your jurisdiction. The defaults are placeholders, not legal advice.
