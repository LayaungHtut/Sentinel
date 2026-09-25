# Demo runbook

An operational checklist for presenting SENTINEL live. The spoken script is in [../DEMO_SCRIPT.md](../DEMO_SCRIPT.md).

## T–30 min: machine

1. `npm install` (first time only), then `npm run build`.
2. `.env` contains `ASSEMBLYAI_API_KEY`. Check without printing it: `grep -c "^ASSEMBLYAI_API_KEY=." .env` should print `1`.
3. `.env` contains `DEMO_LOGIN_ENABLED=true` (and `DEMO_RESET_ENABLED=true` if you want the reset button).
4. Set `ASSEMBLYAI_VOICE_FOCUS=far-field` if you'll use the laptop mic in a room, or `near-field` if you'll wear a headset.
5. With the app **stopped**, run `npm run db:reset`. The next live incident will be **INC-0042**.
6. `npm start` (production build) or `npm run dev`, then open `http://localhost:3000` (start) or `:5173` (dev) in **Chrome**.

## T–10 min: rehearsal

1. Sign in with **Continue with demo**. Home → **Run live demo** → **Start incident** → **I agree, start voice** (asked once per account). Allow the microphone and say one line. Check the status shows LISTENING, then SPEAKING, then LISTENING again.
2. **End**, then reset again (`npm run db:reset` with the app stopped, or **Reset demo data** if `DEMO_RESET_ENABLED=true`).
3. Optionally, run the automated live rehearsal. It needs Windows for the TTS voices and bills your key:
   `node --env-file=.env scripts/live-voice.mjs full-demo`

## Room checks

- The browser zoom should fit all panels (usually 90%).
- Laptop volume should be audible but not so loud it clips. Echo cancellation is on, but a headset is safest.
- In a very noisy hall, use **Type instead**. It still goes through the AssemblyAI agent and is labelled _typed_ on the record.

## If something fails

| Symptom                                   | Action                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| "Microphone access required"              | Click the address-bar mic icon → Allow → **Try again**.                                                                         |
| "VOICE CONNECTION LOST, reconnecting"     | Wait. SENTINEL reconnects with a new session on the same incident. Incident data is safe.                                       |
| "Voice unavailable"                       | Say "the record is safe", then continue with the manual controls (add fact, action status, report) and use **Resume by voice**. |
| Maintenance replies before you want it to | Only the **Contact replies** simulation button does that. Don't touch the demo-simulation box until after the escalation.       |
| Agent misheard a value                    | Correct it by voice ("Actually, it's…"). That demonstrates supersession.                                                        |

## What is simulated (say it if asked)

- The demo organisation, its maintenance staff, managers and escalation _recipients_ are fictional. In the demo organisation nothing is ever sent, and the UI says **demo simulation** everywhere this applies. Real organisations send real SMS, calls, email, Slack or webhooks when configured.
- The 30-second response timeout is demo timing. Real organisations set their own (default 15 minutes) in Settings.
- Escalation timers run on the server, so escalation happens even if you switch tabs.
- Everything else is real: AssemblyAI speech, transcription, turn-taking, barge-in and tool calls, plus the database, rules and report.
