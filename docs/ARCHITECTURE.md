# SENTINEL architecture

```
                         USER (speaks into the browser mic)
                                  │  PCM16 24 kHz, echo-cancelled
                                  ▼
 ┌─────────────────────────── Browser (SvelteKit 5, CSR) ───────────────────────────┐
 │ VoiceAgent client ── AudioWorklet capture · gap-free playback · barge-in flush    │
 │ Command centre ──── Incident · Live voice · Operational state · Evidence ·        │
 │                     Actions · Timeline · Provenance drawer · Replay · Report      │
 └───────┬───────────────────────────────▲──────────────────────────────┬───────────┘
         │ wss://agents.assemblyai.com/v1/ws?token=<single-use temp token>  │ HTTPS (same origin)
         ▼                               │ tool.call / speech / captions │
 ┌──────────────────────────────┐        │                               ▼
 │ AssemblyAI Voice Agent API   │────────┘        ┌──────────────── SvelteKit server ────────────────┐
 │ STT · turn detection ·       │                 │ /api/voice/session  mint token (Bearer key),     │
 │ semantic barge-in · LLM ·    │                 │                     build prompt + tiered tools  │
 │ TTS · tool calling           │                 │ /api/tools/:name    Zod validation → transaction │
 └──────────────────────────────┘                 │                     → audit log (tool_invocations)│
                                                  │ /api/incidents/:id  view + operational state      │
                                                  │ /api/incidents/:id/escalation-check  timeout rule │
                                                  └───────────────┬───────────────────────────────────┘
                                                                  ▼
                              ┌──────────── Domain engine (pure TypeScript, unit-tested) ────────────┐
                              │ state-machine  evidence  severity  playbooks  information            │
                              │ escalation     operational  report  replay                           │
                              └───────────────┬──────────────────────────────────────────────────────┘
                                              ▼
                              ┌──────── PostgreSQL via Drizzle (PGlite embedded or DATABASE_URL) ─────┐
                              │ incidents · facts (supersedes_id) · info_requests · actions           │
                              │ (reason_fact_id) · escalations · timeline_events · transcripts ·      │
                              │ voice_sessions · tool_invocations · reports · contacts                │
                              └───────────────────────────────────────────────────────────────────────┘
```

## One spoken sentence, end to end

1. The browser streams mic audio (`input.audio`, base64 PCM16 24 kHz) to AssemblyAI.
2. AssemblyAI transcribes (`transcript.user`). The browser stores the utterance in `transcripts` first, so tool calls can cite it.
3. The agent emits `tool.call` (for example `add_fact` with `evidence_quote`). The browser POSTs it to `/api/tools/add_fact`.
4. The server validates the arguments against the Zod schema and runs the handler in a transaction:
   - It matches the quote to a stored utterance and records its provenance.
   - A new value for an existing key supersedes the old one (`supersedes_id`) instead of deleting it.
   - The open information request for that key is closed.
   - Severity is recomputed, a timeline event is written, and the call is audited.
5. The result goes back as `tool.result` once `reply.done` arrives (or is dropped if the reply was interrupted). The agent speaks the next question.
6. SENTINEL sends a `session.update` with the refreshed incident record and tool tier, so the agent's prompt always matches the database.

## Evidence model

| Field                                              | Meaning                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `certainty`                                        | `exact` / `approximate` (did the speaker hedge?)                    |
| `basis`                                            | `stated` (someone said it) / `inferred` (SENTINEL concluded it)     |
| `verification`                                     | `unverified` / `confirmed` / `disputed`                             |
| `status`                                           | `current` / `superseded` / `retracted`                              |
| `transcript_id`, `evidence_quote`, `quote_matched` | Where the words came from, and whether the quote was actually found |
| `supersedes_id` / `superseded_by_id`               | The correction chain                                                |
| `actions.reason_fact_id`                           | Evidence → action link                                              |

The UI class (Confirmed, Reported, Unverified, Approximate, Inferred, Disputed) is derived from these fields and never stored, so it cannot drift from the data.

## Honesty boundaries

- No outbound messaging exists. Contacts and escalations carry `notification_status` = `simulated` (demo) or `not_configured`.
- Demo-only simulations (a contact replying, a manager acknowledging) are refused on non-demo incidents and written with source `demo_simulation`.
- Reports are compiled from rows (`domain/report.ts`). No LLM writes them.
- The operational state and risk signals come from the rule engine and the record (`domain/operational.ts`), never from model reasoning.
