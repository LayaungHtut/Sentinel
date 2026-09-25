# SENTINEL architecture

```
                   USER (speaks into a phone, tablet or laptop)
                                  │  mic → AudioWorklet → PCM16 24 kHz
                                  ▼
 ┌────────────────────────── Browser (SvelteKit 5, installable PWA) ─────────────────────────┐
 │ VoiceAgent client: capture · gap-free playback · barge-in flush · consent · reconnect     │
 │ Command centre: incident · live voice · operational state · evidence · actions ·          │
 │ photos · outreach log · hash-verified timeline · provenance · replay · report · settings  │
 └──────────┬───────────────────────────────────────────────────────────▲────────────────────┘
            │ wss /api/voice/relay (cookie, same origin): audio/text/end │ HTTPS (cookie session)
            ▼                                                            │
 ┌──────────────────────────────── SENTINEL server (Node) ─────────────────────────────────────┐
 │ Voice relay ── Bearer key ──► AssemblyAI Voice Agent API (STT · turns · barge-in · LLM · TTS)│
 │   stores transcripts, executes tool calls, tool.result after reply.done, config refresh,     │
 │   system events, resume → fresh-session fallback, session.end on every exit                 │
 │ Tool executor ── tenancy · role check · argument repair · Zod · transaction · audit          │
 │ Incident engine ── state machine · evidence · severity · escalation · reports               │
 │ Outbox ─► Twilio SMS/call · SMTP · Slack · webhook   ◄─ signed receipts · /ack/<token>       │
 │ Scheduler (leader-elected): escalations · outbox · reconciliation · retention · housekeeping │
 │ Auth: users · orgs · roles · sessions · API keys (sensors) · rate limits (Postgres)         │
 └──────────────────────────────────────────────┬──────────────────────────────────────────────┘
                                                ▼
 ┌──────────────────── PostgreSQL via Drizzle (PGlite embedded or DATABASE_URL) ───────────────┐
 │ organizations · users · memberships · auth_sessions · api_keys · contacts                   │
 │ incidents · facts · info_requests · actions · escalations · reports · attachments           │
 │ timeline_events (hash chain, append-only trigger) · tool_invocations (append-only)          │
 │ transcripts (encrypted at rest) · voice_sessions · notifications (outbox) · rate_limits     │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

## One spoken sentence, end to end

1. The browser streams mic audio to the SENTINEL relay as `{type:'audio'}` frames. The relay forwards each frame as `input.audio` on its own AssemblyAI WebSocket, authenticated with the server-held key.
2. AssemblyAI returns `transcript.user`. The relay stores the utterance, attributed to the signed-in speaker, **before** handling any tool call, so tools can cite it. The browser receives the same event for captions.
3. The agent emits `tool.call` (for example `add_fact` with `evidence_quote`). The relay calls the tool executor directly: it checks the organisation and the speaker's role, validates with Zod and runs the handler in a transaction.
   - The quote is matched to a stored utterance and its provenance recorded.
   - A new value for an existing key supersedes the old one instead of deleting it.
   - Severity is recomputed.
   - A hash-chained timeline event and an audit row are written.
   - Any outreach is queued in the outbox.
4. After commit, queued notifications are sent. The relay holds the `tool.result` until `reply.done` is the latest event, and drops it if the reply was interrupted.
5. The relay sends `session.update` with the refreshed incident record and tool tier. Operator edits made in the UI trigger the same refresh.
6. Events from outside the call reach the agent through the relay (`conversation.message` + `reply.create`), and the agent tells the caller. These include a timer escalation, a delivery failure, an acknowledgement and a sensor reading.

## Evidence model

| Field                                              | Meaning                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `certainty`                                        | `exact` / `approximate` (did the speaker hedge?)                                       |
| `basis`                                            | `stated` (a person said it) / `inferred` (SENTINEL concluded it) / `observed` (sensor) |
| `source_type`, `source_ref`                        | voice transcript, typed, operator, sensor (with device reference), demo                |
| `verification`                                     | `unverified` / `confirmed` / `disputed`                                                |
| `status`                                           | `current` / `superseded` / `retracted`                                                 |
| `transcript_id`, `evidence_quote`, `quote_matched` | Where the words came from, and whether the quote was actually found                    |
| `transcripts.stt_confidence`                       | AssemblyAI's confidence for that utterance (post-session reconciliation)               |
| `supersedes_id` / `superseded_by_id`               | The correction chain                                                                   |
| `actions.reason_fact_id`                           | Evidence → action link                                                                 |

The UI class (Confirmed, Sensor reading, Reported, Unverified, Approximate, Inferred, Disputed) is derived from these fields and never stored.

## Integrity

- **Hash chain:** `timeline_events.hash = SHA-256(canonical event + prev_hash)` per incident, with a gap-free `chain_seq`. `verifyChain` recomputes it on every incident load (the badge) and at `/api/incidents/:id/audit`.
- **Database triggers** make `timeline_events` and `tool_invocations` append-only, and make a fact's evidence fields immutable. Facts are never deleted.
- **Outbox:** a notification exists only if its transaction committed, and it is marked `sent` only after the provider accepts it and `delivered` only after a signed receipt.

## Honesty boundaries

- Demo organisations never send anything. Real organisations send only through configured channels, and otherwise say "no message was sent; contact them directly".
- Demo-only simulations are refused outside demo organisations and written with source `demo_simulation`.
- Reports are compiled from rows (`domain/report.ts`). No LLM writes them.
- Operational state and risk signals come from the rule engine and the record, never from model reasoning.

## Reliability

- **Upstream drop** (AssemblyAI socket): the relay tries `session.resume` twice. That was rejected live every time (see [ASSEMBLYAI_SUPPORT_REPORT.md](ASSEMBLYAI_SUPPORT_REPORT.md)), so it then opens a fresh session rebuilt from the database on the same incident.
- **Browser drop** (the caller's network): the server ends that AssemblyAI session (no idle billing). The client opens a new session on the same incident (3 attempts with backoff).
- **Server restart:** `SIGTERM` sends `session.end` for every live call, then exits. Timers live in the database, so escalations continue on the next leader.
- **Multi-instance:** HTTP, jobs, outbox, sessions and rate limits share PostgreSQL. Live-call event delivery is per process; see [OPERATIONS.md](OPERATIONS.md#scaling).
