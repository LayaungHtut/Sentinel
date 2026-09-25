# Voice agent evaluation (live, real AssemblyAI)

Every result below comes from `scripts/live-voice.mjs` running against the **real AssemblyAI Voice Agent API**. No mocks. User turns are Windows SAPI TTS, streamed as real-time 24 kHz PCM16 microphone audio, so STT, turn detection, barge-in, the LLM, tool calls and TTS are all AssemblyAI's live service. Tool calls hit the real SENTINEL server and database, and each run is scored on the **resulting database state**, not on what the agent said.

Scenario definitions: [`tests/voice/*.json`](../tests/voice). Each one specifies the spoken input, expected facts (value, certainty class, provenance), expected actions and statuses, expected unknowns, and forbidden claims (e.g. "I've notified", "sent a message"). Raw per-run results (transcripts, tool calls, final state) are written to `.data/voice-results/*.json`. `scripts/summarize-voice-results.mjs` generated the tables below from those files.

## Scenarios

| Scenario              | What it proves                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| basic-incident        | A messy report becomes a refrigeration incident with location, temperature (unverified), start time (approximate), inventory, unit status, backup and a maintenance action; severity HIGH |
| ambiguous-temperature | "I think it's about twelve… not sure" stays **approximate/unverified** and is never confirmed                                                                                             |
| correction            | "Actually, I checked again, 13.4" supersedes 12°C (kept as history) and confirms 13.4°C; report generated                                                                                 |
| interruption          | The user talks over SENTINEL. The reply is cut (`reply.done status=interrupted`), and "I already moved the food" completes the move action and records the new location                   |
| missing-information   | A vague report opens an incident, asks a question, and tracks what is unknown without inventing a location or temperature                                                                 |
| escalation            | Maintenance doesn't respond within the demo timer, so the rule escalates to Maya Win (simulated), the incident becomes ESCALATED, and SENTINEL says so by voice                           |
| full-demo             | The complete 90-second demo: report, question, barge-in, "get maintenance on it", correction, report and escalation, all in one session                                                   |
| pos-outage            | A second playbook (retail tills) on the same engine                                                                                                                                       |
| degraded-mode         | Manual operation without voice. Covered by the automated e2e suite (`scripts/e2e-inprocess.mjs`), not by a live session                                                                   |

## Results

### Baseline: first live run (before prompt and robustness fixes)

6 scenarios, 1 run each (log: `.data/live-baseline-prefix.log`): **3/6 passed**.

| Failure                                                                  | Root cause                                                                 | Fix                                                                                                                       |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| basic-incident: unit status stayed "stopped working"                     | The agent logged the refinement under a variant key (`unit_status_detail`) | Prompt: refine under the **same key** so the old value becomes history, and never invent variant keys                     |
| correction: `add_fact` rejected (`facts.2.value` missing)                | The model sent `numeric_value` without `value`                             | Server-side **argument repair** (derive the text from number + unit, `minutes_ago` or the quote) before strict validation |
| interruption: food recorded as moved, but the move action stayed pending | The model didn't connect the new fact to an open action                    | `add_fact` results now list open actions and tell the agent to `update_action` when a new fact means one is done          |

A second attempt made `value` optional in the model-facing schema. Live, that made the model omit values **more** often (a create_incident loop, log `.data/live-attempt2-optional-value.log`). It was reverted: the model-facing schema stays strict and repair happens on the server. A unit test now pins `value` as required.

### Final suite: 7 scenarios × 3 runs (log: `.data/live-run-final.log`)

| Scenario              | Runs | Passed | Checks passed | Tool calls (all runs) | Interrupted replies | Failures                                                            |
| --------------------- | ---- | ------ | ------------- | --------------------- | ------------------- | ------------------------------------------------------------------- |
| ambiguous-temperature | 3    | 3/3    | 18/18         | 6 (0 failed)          | 0                   | —                                                                   |
| basic-incident        | 3    | 3/3    | 39/39         | 15 (0 failed)         | 0                   | —                                                                   |
| correction            | 3    | 3/3    | 18/18         | 12 (0 failed)         | 0                   | —                                                                   |
| escalation            | 3    | 3/3    | 18/18         | 7 (0 failed)          | 0                   | —                                                                   |
| full-demo             | 3    | 1/3    | 33/39         | 22 (0 failed)         | 3                   | see below                                                           |
| interruption          | 3    | 3/3    | 18/18         | 12 (0 failed)         | 3                   | —                                                                   |
| missing-information   | 3    | 2/3    | 12/13         | 2 (0 failed)          | 0                   | Run 3: the agent asked "Which fridge?" before creating the incident |

**Total: 18/21 scenario runs passed.** Across the 21 sessions: 159 agent replies, 6 interrupted by barge-in, 1618 s of live conversation, 0 session errors, and 0 failed tool calls.

Full-demo failures and their fixes, each with a regression test that reproduces the exact live arguments:

1. `mark_fact_confirmed` arrived with `corrected_numeric_value: 13.4` but no `corrected_value`, and the server **confirmed the old 12°C**. Fixed: a number-only correction now supersedes. The server also **refuses to confirm a value the user's own words contradict** (the quote mentions 13.4, the record says 12).
2. "Get maintenance on it" re-sent `add_action` with `in_progress` for an existing pending action. The duplicate guard kept it pending while SENTINEL said it had started the contact. Fixed: a repeated action with a more advanced status now advances the record through the normal transition path.

Missing-information run 3 was addressed by strengthening the `create_incident` tool description: even a vague report opens the record first.

### Verification on the final build

Run after the fixes above (log: `.data/live-run-verify.log`).

| Scenario            | Runs | Passed | Checks passed | Tool calls (all runs) | Interrupted replies | Failures                                                                                                       |
| ------------------- | ---- | ------ | ------------- | --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| full-demo           | 3    | 2/3    | 38/39         | 24 (0 failed)         | 2                   | Run 1: barge-in landed while the agent was mid tool call, so the service didn't flag that reply as interrupted |
| missing-information | 3    | 3/3    | 18/18         | 3 (0 failed)          | 0                   | —                                                                                                              |
| pos-outage          | 1    | 1/1    | 8/8           | 4 (0 failed)          | 0                   | —                                                                                                              |

**6/7 runs passed.** Every pipeline stage (auth, session, mic audio, speech detection, transcription, agent speech, tool call, persistence, termination) worked in 7/7 runs, with 0 session errors and 0 failed tool calls.

About the full-demo run 1 miss: the harness started talking over SENTINEL while it was still in a tool-call phase, before any spoken words. The service didn't mark that reply as interrupted. The product outcome was still correct: the move action was completed, SENTINEL said "Got it. I've stopped.", and the correction, maintenance and escalation steps all passed. The harness now barges in only after the agent has spoken at least three words.

### Real browser, real service (`scripts/live-browser.mjs`)

Real Chromium runs the production `VoiceAgent` client. Its microphone is a WAV file (`--use-file-for-fake-audio-capture`), and it connects to the live AssemblyAI endpoint with a SENTINEL-minted temp token. **9/9 steps passed** (log: `.data/live-browser.log`): socket opened with a temp token (key never in the browser), greeting captioned, spoken report transcribed, `create_incident` created INC-0042 with temperature 12 (quote traced to transcript) and location Yangon branch, a follow-up question spoken, `session.end` → `session.ended`, and no page errors. 760 audio/event frames were sent.

### Reconnect (`scripts/live-resume.mjs` + probes)

`session.resume` was rejected with `session_not_found` in **every** live attempt, even well inside the documented 30 s grace window:

| Disconnect                         | Wait  | Auth       | Result              |
| ---------------------------------- | ----- | ---------- | ------------------- |
| client `close()` (1000)            | 2 s   | temp token | `session_not_found` |
| client `close(4000)`               | 1.5 s | temp token | `session_not_found` |
| abrupt TCP drop (`ws.terminate()`) | 1.5 s | temp token | `session_not_found` |
| abrupt TCP drop                    | 8 s   | temp token | `session_not_found` |
| abrupt TCP drop                    | 2 s   | API key    | `session_not_found` |

SENTINEL's response: when resume is rejected, the client **automatically starts a fresh AssemblyAI session bound to the same incident**. The server rebuilds the incident record into the new session's prompt, so the conversation continues with full context from the database. This fallback is covered by the automated e2e suite (a scripted socket that rejects resume exactly as the live service did). DevTools offline emulation didn't sever the live WebSocket, so a real network loss wasn't reproduced in the browser.

Also observed: a temporary token was accepted a second time. The docs describe tokens as single-use. SENTINEL doesn't depend on single-use for security (60 s redemption window, key never leaves the server).

## Forbidden-claim checks

Every scenario checks the agent's spoken lines for claims of real outreach ("sent a message", "texted", "I called", "I've notified", "emailed"). No run in the final suite or the verification batch tripped this check. In demo mode the agent said "I've started a simulated contact with Ko Min".

## Observed conversation quality (examples from live transcripts)

- "Understood. Is there another fridge or freezer the food can go into?"
- "Got it, the food is moved. Have the doors been kept closed since it failed?"
- "Ko Min hasn't responded, so I've escalated this to Maya Win. Do you want to do anything else for now?"
- Barge-in: _"First, move that chicken and dairy to—"_ `[interrupted]` → "Got it, the food is moved…"

## Honest limits of this evaluation

- The input voice is synthetic (Windows SAPI), and a synthetic voice is clean. It doesn't cover accents, background noise, soft or fast speech, or real room acoustics. A real microphone in a noisy room still needs a human rehearsal (see the manual checklist in the README).
- The LLM is non-deterministic, so pass rates are for this run count, not a guarantee.
- Agent audio isn't played into a real room here, so echo cancellation isn't exercised. The browser client relies on the browser's echo cancellation.

## 2026-09-25: re-evaluation on the server-side relay

The harness now signs in, opens the SENTINEL relay like a browser, and lets the server execute tools and fire timers. Scenario runs: **14, of which 12 passed**. Two failures led to fixes, and both scenarios passed on re-run:

- **Escalation not announced:** the agent re-called `create_escalation` after the SYSTEM EVENT. Fix: duplicate-escalation guidance and a prompt rule. Passed 1/1 after.
- **Invented fact category:** the model sent a `category` outside the list and `create_incident` was rejected. Fix: argument repair drops it. Passed 2/2 after.

Full-suite results (single run each): basic-incident, correction, escalation, full-demo (13/13 checks), interruption, missing-information and pos-outage passed; ambiguous-temperature failed before its fix. Small samples: treat these as regression evidence, not a reliability estimate. The nightly workflow accumulates the larger sample.
