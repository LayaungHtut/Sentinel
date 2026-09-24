# SENTINEL

**A voice-operated incident response system. It turns a messy spoken report into structured, evidence-backed action.**

Built for the AssemblyAI Voice Agent Hackathon on the [AssemblyAI Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api), SvelteKit 5, PostgreSQL and Drizzle.

> SENTINEL doesn't just understand what you said. It turns what you said into accountable action, and it can show you where every fact came from.

---

## The problem

The first minutes of an incident matter most, and they are also the messiest. Someone tells a manager, someone scribbles notes, someone phones maintenance. Details get lost and follow-ups get dropped. The report written afterwards contains guesses presented as facts, and nobody can say who said what, or when.

## The solution

You press **Start incident** and talk. SENTINEL, running on the AssemblyAI Voice Agent API:

1. **Listens** to a natural spoken report, with no form filling.
2. **Extracts facts with provenance.** Each fact records its source, the exact words it came from, its timestamp, its precision and its verification state.
3. **Keeps uncertainty.** "About twenty minutes ago" stays approximate. "The display says twelve degrees" is stored as _stated but unverified_. Inferences are labelled as inferences.
4. **Knows what it doesn't know.** A per-incident-type checklist makes unknowns first-class, so SENTINEL asks only the next most useful question.
5. **Creates and tracks actions.** Each action has a status, an owner, a contact and a response timer.
6. **Escalates** when a contact doesn't respond. It never claims a message was sent unless one really was.
7. **Keeps a timestamped evidence timeline** of everything said and done.
8. **Compiles an incident report** deterministically from the database. No LLM "remembers" the incident.

Corrections never erase history. If the reporter re-checks and says "actually, it's 13.4 degrees", the 12°C reading is kept as **superseded** and 13.4°C becomes **current + confirmed**, with both quotes on record.

## Why voice, and why AssemblyAI

The person who sees the incident is usually standing in front of it, with their hands full, stressed, and without time for a form. Speech is how they already report it. The hard part is turning that speech into something accountable, and that is what SENTINEL adds.

The AssemblyAI Voice Agent API is the right foundation because one WebSocket provides the whole conversational loop: streaming STT, **semantic turn detection**, **semantic barge-in** ("uh-huh" doesn't interrupt, "wait, stop" does), an LLM with **tool calling**, and TTS. SENTINEL's value sits in the tools. Every tool call becomes validated, persisted, auditable state.

**Documentation:** [Architecture](docs/ARCHITECTURE.md) · [Real AssemblyAI validation](docs/REAL_ASSEMBLYAI_VALIDATION.md) · [Voice agent evaluation](docs/VOICE_AGENT_EVALUATION.md) · [Demo runbook](docs/DEMO_RUNBOOK.md) · [90-second script](DEMO_SCRIPT.md)

---

## What is real, simulated, or not implemented

| Real                                                                                                                                    | Simulated (demo mode only, always labelled)                                             | Not implemented, by design                    |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------- |
| AssemblyAI Voice Agent API: speech-in, speech-out, STT, LLM, TTS, turn detection, barge-in, tool calling (**validated live**, see docs) | Replies from people outside the call (maintenance "calls back", a manager acknowledges) | SMS, WhatsApp, email and phone notifications  |
| Server-side tool execution with validation, transactions and an audit log                                                               | 30-second response timeout (production policy: 15 minutes)                              | Authentication and multi-tenant organisations |
| PostgreSQL persistence (embedded PGlite or any Postgres)                                                                                | Demo organisation and people (fictional)                                                | Sensor or IoT integrations                    |
| Fact provenance, supersession, confirmation, unknowns                                                                                   |                                                                                         |                                               |
| Incident and action state machines, validated server-side                                                                               |                                                                                         |                                               |
| Rule-based, explainable severity                                                                                                        |                                                                                         |                                               |
| Response-timeout escalation rule                                                                                                        |                                                                                         |                                               |
| Deterministic report generation (UI, Markdown, print)                                                                                   |                                                                                         |                                               |

In the UI and the data, every escalation and contact carries a notification status: `simulated` (demo) or `not_configured` (no channel). Nothing is ever shown as "sent".

---

## Architecture

```mermaid
flowchart LR
    subgraph Browser
        MIC[Mic → AudioWorklet<br/>PCM16 24 kHz] --> VA[VoiceAgent client]
        VA --> SPK[Speaker<br/>flushable playback]
        UI[Command-centre dashboard]
    end
    subgraph AssemblyAI["AssemblyAI Voice Agent API"]
        WS[(wss://agents.assemblyai.com/v1/ws<br/>STT · LLM · TTS · turn detection)]
    end
    subgraph Server["SvelteKit server"]
        TOK[/api/voice/session<br/>mint temp token + session config/]
        TOOLS[/api/tools/:name<br/>Zod validation → transaction/]
        ENGINE[Incident engine<br/>state machine · evidence · severity · escalation]
        REPORT[Report compiler]
    end
    DB[(PostgreSQL<br/>Drizzle ORM)]

    VA -- "1. start" --> TOK
    TOK -- "GET /v1/token (Bearer key)" --> AssemblyAI
    VA <-- "2. session.update / audio / events" --> WS
    WS -- "3. tool.call" --> VA
    VA -- "4. POST tool args" --> TOOLS --> ENGINE --> DB
    TOOLS -- "result" --> VA -- "5. tool.result after reply.done" --> WS
    UI -- poll / operator tools --> TOOLS
    ENGINE --> REPORT
```

**The core loop:** voice → AssemblyAI → understanding → `tool.call` → structured incident state (Postgres) → voice response → action.

### Code layout

```
src/lib/domain/         Pure, tested domain logic (runs on client and server)
  types.ts              Vocabulary: statuses, certainty, verification, sources
  state-machine.ts      Incident and action transitions + automatic progressions
  evidence.ts           Epistemic classification, quote → transcript matching
  severity.ts           Explainable rule-based severity
  playbooks.ts          Per-incident-type checklists, actions, escalation chains
  information.ts        Known / open / unavailable checklist
  escalation.ts         Response-timeout rule
  report.ts             Deterministic report builder + Markdown renderer
src/lib/server/
  db/                   Drizzle schema (CHECK constraints), dual driver (pg / PGlite)
  tools/                14 tool schemas (Zod → JSON Schema), handlers, executor + audit
  incidents/            Repository, engine (facts, severity refresh, escalation check)
  assemblyai/           Token minting, system prompt, tiered tools, voice sessions
  demo/                 Seed data (fictional) and labelled simulator
src/lib/voice/          Browser Voice Agent client, audio engine, capture worklet
src/lib/components/     Dashboard, voice, evidence, actions, timeline, report UI
src/routes/             Pages + /api endpoints
drizzle/                Generated SQL migrations
scripts/                DB CLI and in-process end-to-end runner
```

---

## AssemblyAI integration

Everything below was checked against the current AssemblyAI docs (`llms.txt`, the Voice Agent API pages and the AsyncAPI/OpenAPI specs) before implementation.

| Concern                       | How SENTINEL does it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product                       | **Voice Agent API**: managed full-duplex speech-in/speech-out with tool calling. It is not Realtime STT plus a separate LLM.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Browser auth                  | The server calls `GET https://agents.assemblyai.com/v1/token?expires_in_seconds=60&max_session_duration_seconds=1800` with `Authorization: Bearer <key>`. The browser gets a **single-use** token and opens `wss://agents.assemblyai.com/v1/ws?token=…`. The API key never reaches the client. A fresh token is minted for every connect and resume.                                                                                                                                                                              |
| Configuration                 | Inline `session.update`: `system_prompt`, `greeting` ("I'm listening. Tell me what happened."), `output.voice` (default `jane`, validated against the documented list), `input.keyterms` (branch names, staff names, equipment), `input.transcription_prompt`, `tools`. Immutable fields (`greeting`, `output.voice`) are sent only on the first update.                                                                                                                                                                          |
| Tools                         | Flat function-tool schema `{type:"function", name, description, parameters, execution_mode:"interactive", timeout_seconds}`. Parameters are generated from the same Zod schemas the server validates with, and include `enum`, `examples` and descriptions.                                                                                                                                                                                                                                                                       |
| Progressive reveal            | Before an incident exists, only `create_incident` is exposed. After it succeeds, SENTINEL sends a `session.update` with the response-phase tools (≤12) and a system prompt that embeds the live incident record.                                                                                                                                                                                                                                                                                                                  |
| Tool results                  | `tool.call` → browser POSTs to `/api/tools/:name` → server executes in a transaction → the result is held until `reply.done` is the latest event, then sent as `tool.result` (`is_error` on failure). On `reply.done status:"interrupted"` pending results are dropped, as documented. Tools are idempotent, so retries after a barge-in don't duplicate facts, actions or escalations.                                                                                                                                           |
| Audio                         | `getUserMedia({echoCancellation:true, noiseSuppression:false})`. The AudioContext runs at the device rate and the worklet resamples to 24 kHz PCM16 (Firefox/Safari-safe pattern). Audio is sent as base64 in `input.audio` only after `session.ready`. `reply.audio` chunks are scheduled gap-free.                                                                                                                                                                                                                              |
| Barge-in                      | On `reply.done` with `status:"interrupted"`, all queued `AudioBufferSourceNode`s are stopped at once. `transcript.agent.interrupted` is shown in the transcript.                                                                                                                                                                                                                                                                                                                                                                  |
| System events and typed input | Escalations and simulations are announced via `reply.create` whose `instructions` carry the event text. A `conversation.message` (role `system`) is also sent for context. Live testing showed a **user-role** `conversation.message` is not seen by the agent, so typed input ('Type instead') is also carried in `reply.create` instructions.                                                                                                                                                                                   |
| Lifecycle                     | `session.ready` (the `session_id` is stored) → … → `session.end` → wait for `session.ended`. `pagehide` sends `session.end` synchronously. A client-side timer respects `max_session_duration_seconds`.                                                                                                                                                                                                                                                                                                                           |
| Reconnect                     | An unexpected close (no `session.ended`) triggers reconnect: a new token, then `session.resume` with the saved `session_id`. Live, the service rejected resume with `session_not_found` every time, so on rejection the client **starts a fresh session bound to the same incident**. The prompt is rebuilt from the database, so facts, unknowns and actions carry over. If that also fails, the UI shows _"Voice unavailable. Your incident data is safe."_ Handshake failures and fatal `session.error` codes are not retried. |

---

## Setup

Requirements: **Node.js ≥ 20.6** (tested on 24) and npm. You don't need a separate database for local use.

```bash
npm install
cp .env.example .env         # then set ASSEMBLYAI_API_KEY
npm run dev                  # http://localhost:5173
```

On first start the app applies migrations and seeds fictional demo data automatically.

### Environment variables

| Variable                 | Required  | Description                                                                                          |
| ------------------------ | --------- | ---------------------------------------------------------------------------------------------------- |
| `ASSEMBLYAI_API_KEY`     | For voice | Server-side only. Without it, voice is shown as _not configured_ and everything else works manually. |
| `ASSEMBLYAI_VOICE`       | No        | One of `alba eve george jane jean mary michael anna charles paul vera`. Default `jane`.              |
| `ASSEMBLYAI_VOICE_FOCUS` | No        | `input.voice_focus`: `far-field` (default, laptop or room mic) or `near-field` (headset).            |
| `DATABASE_URL`           | No        | Any PostgreSQL URL (Neon, Supabase, Docker…). Empty = embedded PostgreSQL (PGlite).                  |
| `PGLITE_DATA_DIR`        | No        | Where embedded Postgres stores data. Default `.data/pglite`.                                         |
| `PG_POOL_MAX`            | No        | node-postgres pool size (default 10).                                                                |
| `SEED_DEMO_DATA`         | No        | `false` disables the automatic demo seed.                                                            |
| `DEMO_RESET_ENABLED`     | No        | `true` enables **Reset demo data** (wipes all incidents). Off by default.                            |

### Database

- **Zero-setup:** leave `DATABASE_URL` empty. SENTINEL runs a real PostgreSQL engine (PGlite, WASM) in-process, persisted under `.data/pglite`.
- **Hosted or Docker Postgres:** set `DATABASE_URL`, e.g.
  ```bash
  docker run -d --name sentinel-pg -e POSTGRES_PASSWORD=sentinel -e POSTGRES_USER=sentinel -e POSTGRES_DB=sentinel -p 5432:5432 postgres:17
  # .env → DATABASE_URL=postgres://sentinel:sentinel@localhost:5432/sentinel
  ```
- Commands: `npm run db:migrate` · `npm run db:seed` · `npm run db:reset` (wipe and reseed) · `npm run db:generate` (after schema changes).
  With embedded PGlite, **stop the app before running the DB CLI**, because only one process may open `.data/pglite` at a time.

Schema highlights: `incidents`, `facts` (with `supersedes_id`/`superseded_by_id` and a partial unique index giving one current value per key), `info_requests` (unknowns), `actions`, `escalations` (a partial unique index makes the timeout rule idempotent), `timeline_events`, `transcripts`, `voice_sessions`, `tool_invocations` (audit log), `reports` (versioned), `contacts`. Every enum column has a `CHECK` constraint.

### Production build

```bash
npm run build
npm start                     # node build (reads .env)
```

The microphone needs **HTTPS or localhost**.

---

### Voice configuration

The configuration is sent inline in `session.update` and built server-side in `src/lib/server/assemblyai/session-config.ts`:

- `system_prompt`, which embeds the live incident record and is refreshed after every tool call
- `greeting`
- `output.voice`
- `input.keyterms` (branch names, staff names, equipment)
- `input.transcription_prompt`
- `input.voice_focus`
- tiered `tools`

Everything else stays at the documented defaults, including semantic turn detection and barge-in. `agent_context` is a **Streaming STT** parameter, not a Voice Agent API field, so it isn't used. The Voice Agent API manages both sides of the conversation itself.

## Demo walkthrough

See **[DEMO_SCRIPT.md](DEMO_SCRIPT.md)** for the 90-second version and **[docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md)** for the checklist. In short:

1. Home → **Run live demo** → **Start incident**. SENTINEL: _"I'm listening. Tell me what happened."_
2. Report it messily. INC-0042 appears with 12°C **unverified**, start time **approximate**, HIGH (assessing) with reasons, and the unknowns listed.
3. Answer one question, then ask "what should we do?" and **talk over SENTINEL**: "Wait, stop, I already moved the food." It stops mid-sentence and the move action becomes **completed**.
4. "Please get maintenance on it." After 30 s with no reply, SENTINEL escalates to Maya Win (**demo simulation**) and says so.
5. "Actually, I checked again, thirteen point four." 12°C is **superseded** and 13.4°C is **confirmed**.
6. "Generate the incident report." → **View report** or **Replay**.

The second scenario (**Retail POS failure**) runs on the same engine with a different playbook.

---

## Testing

```bash
npm run check        # svelte-check / TypeScript
npm test             # unit + integration (Vitest, real PostgreSQL via PGlite)
npm run test:e2e     # production build + browser e2e incl. mocked AssemblyAI socket
npm run lint
```

- **Unit tests** (`src/lib/domain/domain.spec.ts`): severity, state transitions, fact certainty, evidence/quote matching, superseding, action transitions, escalation rules, checklist, report generation.
- **Integration tests** (`src/lib/server/tools/tools.integration.spec.ts`): the full refrigeration scenario through the tool executor on real PostgreSQL. Covers create, update, facts with provenance, untraceable quotes, idempotency, correction and supersession, actions, invalid transitions, timeout escalation (exactly once), the simulator, reports, validation and audit, and closing rules.
- **Driver test** (`src/lib/server/db/postgres-driver.integration.spec.ts`): the `DATABASE_URL` path (node-postgres wire protocol) including migrations and CHECK constraints.
- **AssemblyAI config tests** (`src/lib/server/assemblyai/assemblyai.spec.ts`): token endpoint, URL and Bearer header (mocked fetch), voice-ID validation, tool schema shape, progressive reveal, immutable fields and prompt honesty rules.
- **Live voice evaluation** (`scripts/live-voice.mjs`, scenarios in `tests/voice/*.json`): runs against the **real AssemblyAI service**. Each user turn is synthesised with Windows TTS and streamed as real-time 24 kHz mic audio. Real STT, turn detection, barge-in, LLM tool calls and TTS then drive the real SENTINEL server, and the resulting database state is checked against each scenario's expected facts, actions, unknowns and forbidden claims. It's billed to your key: `npm run build && node --env-file=.env scripts/live-voice.mjs [scenario…] [--runs N]`. Results: [docs/VOICE_AGENT_EVALUATION.md](docs/VOICE_AGENT_EVALUATION.md).
- **End-to-end** (`scripts/e2e-inprocess.mjs`): serves the production build in-process and drives real Chromium with a fake microphone. With `--voice-mock` it replaces `wss://agents.assemblyai.com/v1/ws` with a scripted server that speaks the documented protocol. It verifies the temp-token URL (no API key in the browser), the inline config, PCM streaming after `session.ready`, `tool.call` → server → `tool.result` after `reply.done`, progressive tool reveal, transcript provenance, captions, barge-in, error results, the **real 30 s escalation reaching the agent as a SYSTEM EVENT**, and `session.end`/`session.ended`. Add `--shots <dir>` for screenshots.

### Manual voice checklist (with a real key)

| #   | Check                 | Expected                                                                                                                    |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Microphone permission | Browser prompt. Denying it shows _"Microphone permission was denied"_ and manual mode still works.                          |
| 2   | Connection            | Status goes Connecting → Listening. The greeting is spoken.                                                                 |
| 3   | Speech recognition    | Partial captions while you speak, then the final text in the transcript.                                                    |
| 4   | Agent response        | One short question at a time, with the key fact acknowledged.                                                               |
| 5   | Tool calls            | "Tool calls → incident record" feed shows ✓ create_incident. Incident panel fills in.                                       |
| 6   | Interruption          | Talk over SENTINEL. Audio stops immediately and the reply is marked _interrupted_.                                          |
| 7   | Correction            | Give a new reading. The old value is superseded and visible in the provenance drawer.                                       |
| 8   | Escalation            | Contact action awaits a response. After 30 s: escalated, spoken announcement, labelled demo simulation.                     |
| 9   | Termination           | **End voice** → _Session ended_. Timeline shows "Voice session ended".                                                      |
| 10  | Reconnect             | Toggle the network off briefly: _VOICE CONNECTION LOST, reconnecting_, then resumed or _Voice unavailable, data preserved_. |

---

## Security

- The AssemblyAI API key is **server-only** (`$env/dynamic/private`). Browsers get single-use temp tokens with a 60 s redemption window and a 30-minute session cap.
- Every tool argument is validated with strict Zod schemas. Unknown keys are stripped and unknown tool names rejected, and every call (including failures) is written to `tool_invocations`.
- State transitions are validated server-side. The database enforces CHECK constraints and uniqueness invariants.
- Per-IP fixed-window rate limits on all API routes. Request body size is capped.
- Upstream error bodies are never forwarded to the client.
- Transcript and fact text is rendered as text (no `{@html}`).
- Headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and a `Permissions-Policy` that allows the microphone for this origin only.
- Demo reset is disabled unless explicitly enabled.

## Limitations (honest)

- **Live-validated, not production-proven.** 41 live AssemblyAI runs (31 passed) with synthetic TTS voices, plus real-browser runs; see [docs/REAL_ASSEMBLYAI_VALIDATION.md](docs/REAL_ASSEMBLYAI_VALIDATION.md). Real human voices, accents and noisy rooms still need a human rehearsal. The LLM is non-deterministic: the full 90-second demo passed 2 of 3 runs on the final build.
- **`session.resume` was rejected by the live service** in every attempt. SENTINEL falls back to a fresh session on the same incident, rebuilding context from the database. AssemblyAI's own conversational memory is lost across that reconnect.
- **No authentication.** SENTINEL is a single-tenant local/demo app. Don't expose it publicly as-is: anyone who can reach it can mint voice sessions billed to your key.
- **No outbound notifications.** Contacts are tracked, not messaged.
- Response-timeout escalations are evaluated while an incident dashboard is open (the page ticks the server-side rule). With no dashboard open, they fire the next time one is opened.
- Severity rules are deliberately simple and keyed to playbook facts. They support triage and are not a certified risk model.
- Quote-to-transcript matching is lexical (with spoken-number normalisation). Paraphrased quotes are flagged as _not traced_ rather than guessed.
- Transcript timestamps are receipt times (and offsets from session start), not word-level audio timings.
- The rate limiter is in-memory, so it's per process.
- Browser testing covered Chromium. Firefox and Safari use the documented resampling pattern but were not tested.

## Roadmap

Real notification channels (Twilio SMS/voice via AssemblyAI SIP, email) with delivery receipts · a server-side scheduler for timeouts · auth, roles and organisations · photo evidence · sensor readings as `observed` facts · multilingual reporting (Burmese input) · incident analytics.
