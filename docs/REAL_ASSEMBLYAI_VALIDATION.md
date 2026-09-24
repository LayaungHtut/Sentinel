# Real AssemblyAI validation

Validation date: 2026-09-24. Service: AssemblyAI **Voice Agent API** (`wss://agents.assemblyai.com/v1/ws`), inline session configuration, voice `jane`, `input.voice_focus: far-field`.

The API key was configured in `.env` and checked **only for presence**. It was never printed, logged or committed. A scan of `build/`, the client bundle and every run log found no occurrence of it.

## How it was tested

| Harness                                                | What is real                                                                                                             | What is synthetic                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `scripts/live-voice.mjs` (scenarios in `tests/voice/`) | AssemblyAI auth, session, STT, turn detection, barge-in, LLM, tool calls, TTS; the SENTINEL server, tools and PostgreSQL | The user's voice (Windows SAPI TTS, streamed as real-time 24 kHz PCM16) |
| `scripts/live-browser.mjs`                             | The above **plus real Chromium** running the production `VoiceAgent` client (worklet capture, WebSocket, playback, UI)   | The microphone is a WAV file (`--use-file-for-fake-audio-capture`)      |
| `scripts/live-resume.mjs` + probes                     | Disconnect and `session.resume` against the live service                                                                 | —                                                                       |

The live tests used no mocked AssemblyAI behaviour. The scripted socket in `scripts/e2e-inprocess.mjs` is used only by the automated regression suite.

## Results

| Capability                                                                                               | Result                                  | Evidence                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication (server mints temp token, `GET /v1/token`, Bearer key)                                    | **PASS**                                | Every attempted session started: 42 in the logged scenario/resume batches, plus 2 real-browser runs and 5 resume probes                                                                                                                         |
| Session initialization (`session.update` → `session.ready`, inline config, voice, keyterms, voice_focus) | **PASS**                                | Every attempted session reached `session.ready`                                                                                                                                                                                                 |
| Microphone (browser capture → worklet → PCM16 24 kHz)                                                    | **PASS**                                | Real Chromium run: 760 frames sent. Scenario runs stream real-time PCM                                                                                                                                                                          |
| Speech → AssemblyAI                                                                                      | **PASS**                                | `input.speech.started` in every run                                                                                                                                                                                                             |
| AssemblyAI → transcript                                                                                  | **PASS**                                | `transcript.user` in every run. Numbers normalised ("12 degrees", "13.4 degrees")                                                                                                                                                               |
| Agent speech (TTS, `reply.audio`, captions)                                                              | **PASS**                                | Every run. Audio streamed in real time (e.g. 12.6 s of audio over 12.58 s)                                                                                                                                                                      |
| Tool calling (`tool.call` → SENTINEL `/api/tools`)                                                       | **PASS**                                | 8 distinct tools succeeded live, counted from logs: create_incident (37), add_fact (40), add_action (24), update_action (13), mark_fact_confirmed (10), generate_incident_report (10), create_escalation (3), request_information (1)           |
| Tool result (`tool.result` after `reply.done`, `is_error`)                                               | **PASS**                                | Agent recovered from `is_error` results and followed tool `guidance`                                                                                                                                                                            |
| Database persistence                                                                                     | **PASS**                                | Every scenario is scored on the resulting DB state (facts, supersession, actions, escalations, reports)                                                                                                                                         |
| Interruption (semantic barge-in)                                                                         | **PASS**                                | 10 replies cut with `reply.done status=interrupted` across the logged runs. The interruption scenario passed 4/4 on post-fix builds                                                                                                             |
| Session termination (`session.end` → `session.ended`)                                                    | **PASS**                                | `session.ended` observed after every deliberate `session.end` except one, which didn't arrive within the harness's 4 s wait. Sessions stopped by aborting the harness, or dropped on purpose for the resume test, are excluded                  |
| Reconnect (`session.resume`)                                                                             | **FAIL (service)**, handled by fallback | `session.resume` → `session_not_found` in 5/5 live attempts, including abrupt TCP drops within 2 s. SENTINEL now falls back to a fresh session on the same incident (automated test). A real network loss wasn't reproduced live in the browser |

## Runs

| Batch                                                           | Build                               | Runs   | Passed | Failed                                                                              |
| --------------------------------------------------------------- | ----------------------------------- | ------ | ------ | ----------------------------------------------------------------------------------- |
| Baseline (first live run)                                       | before fixes                        | 6      | 3      | 3                                                                                   |
| Interruption + basic (early check)                              | prompt v2                           | 2      | 2      | 0                                                                                   |
| Attempt with relaxed schema (aborted)                           | regression, reverted                | 3      | 1      | 2                                                                                   |
| Final suite (7 scenarios × 3)                                   | prompt v3 + argument repair         | 21     | 18     | 3 (two fixed afterwards, one prompt-strengthened)                                   |
| Verification (full-demo ×3, missing-information ×3, pos-outage) | + correction/duplicate-action fixes | 7      | 6      | 1 (harness barge-in timing)                                                         |
| Real browser (`live-browser.mjs`)                               | + UI polish                         | 2      | 1      | 1 (harness waited for the "Listening" label while the UI already showed "Speaking") |
| **Post-fix total (final suite + verification + browser)**       |                                     | **30** | **25** | **5**                                                                               |

Runs completed: **41**. Successful: **31**. Failed: **10**. All failures and their causes are listed below. A PASS in the results table means the capability worked in live traffic; it does not mean every scenario run passed.

Failure causes, and what changed:

1. The agent used variant fact keys instead of superseding → prompt rule (same key, never variants).
2. The model omitted `value` → server-side argument repair. **Do not** relax the model-facing schema: that made omissions worse live, and a unit test now pins it.
3. A new fact didn't complete the matching action → `add_fact` guidance lists open actions.
4. A number-only correction confirmed the old value → fixed. The server also refuses confirmations contradicted by the user's quote.
5. A repeated action didn't advance to in progress while SENTINEL said it had → fixed. Words and record now agree.
6. A vague report didn't open an incident first → tool description strengthened.
7. Barge-in timing in the harness (tool-call phase) → harness waits for spoken words.
8. `session.resume` rejected by the service → fresh-session fallback in the client.
9. One early session closed about 8 s in with no transcript (seen before close codes were logged). It hasn't recurred since logging was added.

Full per-scenario tables: [VOICE_AGENT_EVALUATION.md](VOICE_AGENT_EVALUATION.md).

## Documentation checks made before and during integration

Checked against the live docs (`llms.txt`, `llms-full.txt`, the Voice Agent pages and the AsyncAPI/OpenAPI specs):

- WebSocket URL
- `?token=` browser auth
- the token endpoint and its limits
- inline `session.update` fields and their mutability
- event names
- flat function-tool schema
- `tool.result` timing
- `reply.done` `interrupted`
- `session.end`/`session.ended`
- `session.resume`
- voice IDs
- `input.voice_focus`
- `transcription_prompt`
- `keyterms`

Two things were deliberately **not** used:

- `agent_context` is documented for the Streaming STT API only, not the Voice Agent API.
- `resume_token` (present in `session.ready`) has no documented use in `session.resume`.

Divergences found live:

- A user-role `conversation.message` is not seen by the agent, so SENTINEL carries typed input in `reply.create` instructions.
- `session.resume` is rejected.
- A token was accepted twice.
