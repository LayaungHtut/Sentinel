# Operations

How to deploy, configure, monitor and scale SENTINEL. The security model is in [SECURITY.md](SECURITY.md).

## Deploy

### Docker Compose (PostgreSQL 17 + app)

```bash
cp .env.example .env      # set ASSEMBLYAI_API_KEY, DATA_ENCRYPTION_KEY, ORIGIN, PUBLIC_BASE_URL
docker compose up --build # http://localhost:3000
```

On first start, open the URL: `/setup` creates your organisation and its first administrator. Migrations run automatically at startup.

### Any container platform

`Dockerfile` builds a non-root Node 22 image. Its healthcheck calls `/api/ready`. `SIGTERM` ends live voice sessions (`session.end`, which stops AssemblyAI billing) and stops the scheduler before exiting. The platform must:

- terminate TLS (the microphone requires HTTPS) and forward WebSocket upgrades on `/api/voice/relay`
- set `ORIGIN` and `PUBLIC_BASE_URL` to the public URL
- provide `DATABASE_URL` (managed PostgreSQL 14+)

### Without Docker

```bash
npm ci && npm run build
npm start        # node server/index.js: SvelteKit handler + voice relay WebSocket
```

`npm start` must be used rather than `node build`. The plain adapter-node server has no WebSocket upgrade handler.

## Configuration

All settings are environment variables. See `.env.example` for the full annotated list. Per-organisation policy is edited in **Settings** by administrators:

| Policy                    | Default                  | Effect                                                                  |
| ------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| Response timeout          | 15 min (demo org: 30 s)  | An awaited contact who hasn't responded is escalated automatically      |
| Retention                 | 365 days (demo org: 30)  | Older transcript text and evidence quotes are redacted; 0 keeps forever |
| Delete AssemblyAI records | off                      | Retention also deletes the provider's stored session and recording      |
| Voice concurrency / day   | 3 sessions / 180 minutes | Cost cap per organisation; exceeding it returns a clear message         |

### Notifications

Each channel turns on when its credentials are present. Contacts choose a channel in Settings. Without one, SENTINEL says so ("no message was sent; contact them directly") rather than pretending.

| Channel    | Variables                                                       | Notes                                                                                                |
| ---------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| SMS / call | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Delivery receipts: Twilio posts to `$PUBLIC_BASE_URL/api/webhooks/twilio/status` (signature-checked) |
| Email      | `SMTP_URL`, `EMAIL_FROM`                                        | `sent` = accepted by your SMTP server                                                                |
| Slack      | `SLACK_WEBHOOK_URL`                                             | Incoming webhook                                                                                     |
| Webhook    | `NOTIFY_WEBHOOK_URL`, `NOTIFY_WEBHOOK_SECRET`                   | JSON body; `x-sentinel-signature: sha256=<HMAC>`. Bridge to PagerDuty, Opsgenie, Teams…              |

Each message includes a one-time acknowledgement link (`/ack/<token>`). Opening it lets the recipient acknowledge without an account, and the response is recorded on the incident and announced on any live voice call.

### Sensors and integrations

Create an API key in Settings, then post readings:

```bash
curl -X POST "$PUBLIC_BASE_URL/api/observations" \
  -H "Authorization: Bearer snt_..." -H "content-type: application/json" \
  -d '{"incident":"INC-0042","source":"walkin-probe-7","readings":[{"key":"temperature","numeric_value":14.2,"unit":"C"}]}'
```

Instead of `incident`, `{"open":{"title":"Freezer alarm","type":"refrigeration_failure"}}` opens a new incident. Readings become facts with basis **observed** and source **sensor**, shown as sensor readings and never as something a person said.

## Background jobs

`SCHEDULER_ENABLED=true` (default) runs these in every instance. One instance is elected leader through a PostgreSQL session advisory lock and does the work. If it dies, another takes over within seconds.

| Job            | Every | Does                                                                                |
| -------------- | ----- | ----------------------------------------------------------------------------------- |
| escalations    | 2 s   | Escalates overdue awaited contacts; announces on live voice sessions                |
| outbox         | 5 s   | Sends queued notifications (the normal path sends right after the commit)           |
| reconciliation | 30 s  | Cross-checks ended sessions with AssemblyAI's session record; stores STT confidence |
| retention      | 1 h   | Redacts old transcripts per organisation policy                                     |
| housekeeping   | 1 h   | Purges expired sign-in sessions and rate-limit rows                                 |

## Monitoring

| Endpoint       | Auth                    | Use                                                     |
| -------------- | ----------------------- | ------------------------------------------------------- |
| `/api/health`  | none                    | Liveness (`{"ok":true}`, reveals nothing)               |
| `/api/ready`   | none                    | Readiness: the database answers (503 otherwise)         |
| `/api/metrics` | `Bearer $METRICS_TOKEN` | Prometheus text format; 404 when no token is configured |

Metrics (per process): `sentinel_tool_calls_total{tool,origin,ok}`, `sentinel_tool_duration_ms`, `sentinel_voice_sessions_total`, `sentinel_voice_session_seconds_total`, `sentinel_voice_reply_latency_ms` (end of user turn → first agent audio), `sentinel_voice_interruptions_total`, `sentinel_escalations_total`, `sentinel_notifications_total{channel,status}`, `sentinel_http_errors_total`, `sentinel_voice_relays_active`.

Logs are JSON lines on stdout (`LOG_LEVEL`), each with a `requestId` that is also returned in the `X-Request-Id` header and in error responses. Transcript text and secrets are never logged.

Suggested alerts: `/api/ready` failing; notifications with `status="failed"`; voice reply latency p95 > 3 s; tool call error ratio > 10%; zero `escalations` job runs (scheduler stalled).

## Scaling

- The HTTP side is stateless. Sessions, rate limits, jobs and the outbox all live in PostgreSQL, so you can run several instances behind a load balancer.
- **Voice relays are per process.** A voice WebSocket stays on the instance it connected to, which is normal load-balancer behaviour for WebSockets. SENTINEL events for a live call (escalations, receipts, acknowledgements, sensor readings) are delivered through an in-process bus. With several instances, an event raised on a different instance than the caller's is recorded and shown in the dashboard, but **not spoken on that call**. To remove this limit, publish bus events through PostgreSQL `LISTEN/NOTIFY` (not implemented).
- Measured on one laptop process with the embedded database and a mock agent (`node scripts/load-relay.mjs`): 25 concurrent sessions streaming real-time audio for 20 s. Session setup took p50 229 ms (p95 277 ms) and a tool round trip p50 41 ms (p95 549 ms), with 0 errors. The chaos variant (`--chaos`, 20 sessions, 3 upstream sockets killed) recovered 3/3 with fresh sessions and 0 errors. These are single-machine figures, not a capacity guarantee; repeat them on your hardware with `LOAD_DATABASE_URL` pointing at your PostgreSQL.

## Backups and recovery

- Back up PostgreSQL with your provider's point-in-time recovery. Everything, including the audit chain, is in the database, and there is no other state.
- Keep `DATA_ENCRYPTION_KEY` in a secret manager. Encrypted text cannot be restored without it.
- After a restore, `GET /api/incidents/:id/audit` confirms each incident's chain is intact.

## Voice evaluation

- `npm run test:e2e` covers the whole voice path against a mock agent on every CI run.
- `.github/workflows/voice-nightly.yml` runs the scripted scenarios against the real service when the `ASSEMBLYAI_API_KEY` repository secret is set. It fails below an 80% pass rate. This bills roughly 10–15 minutes of voice-agent time per run.
- Add real recordings to a scenario with `"audio": "tests/voice/audio/<file>.wav"` on a turn (24 kHz, mono, 16-bit PCM). Recorded human voices, accents and noise are the next evaluation gap to close.
