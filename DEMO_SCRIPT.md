# SENTINEL — 90-second demo script

**Goal:** by the end, the judge should be thinking _"it understands the incident, knows what's missing, turns it into actions, and can show where each fact came from."_

## Before you present (2 minutes, off-stage)

1. With the app **stopped**, run `npm run db:reset` so the live incident will be **INC-0042** and the history shows INC-0040/41. (Alternatively set `DEMO_RESET_ENABLED=true` and use **Reset demo data** on the home page.)
2. `npm run dev` (or `npm run build && npm start`) and open `http://localhost:5173` in **Chrome**.
3. Check the header says **Voice ready**. If it says _not configured_, `ASSEMBLYAI_API_KEY` is missing.
4. Open **Run live demo**. Press **Start incident** once to grant microphone permission, then **End** and reload.
5. Use a headset mic or a quiet spot. Browser echo cancellation is on, but a noisy hall hurts any voice demo.
6. Zoom the browser to 90% so all five panels fit on the projector.

---

## The script

| Time                   | You do / say                                                                                                                                                                                       | Point at                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **0:00** Problem       | _"Most incident reports start as a messy conversation. Facts get lost, guesses become 'facts', and nobody can say who said what."_                                                                 | Home: **Voice → Transcript → Evidence → Action → Escalation → Report**                                                                     |
| **0:05** Start         | Click **Run live demo** → **Start incident**. SENTINEL: _"I'm listening. Tell me what happened."_                                                                                                  | Voice panel: **LISTENING** + mic meter                                                                                                     |
| **0:10** Messy report  | Say: **"The refrigeration unit at our Yangon branch stopped cooling about twenty minutes ago. It's showing twelve degrees and we've got frozen chicken and dairy inside."**                        | Feed: ✓ `create_incident`. **INC-0042**. Raw report → structured block                                                                     |
| **0:20** Understanding | _"No form, and look at the evidence."_                                                                                                                                                             | **12°C · ⚠ UNVERIFIED**, start **≈ approximate**, **HIGH · assessing** + _Why HIGH?_                                                       |
| **0:25** Clarification | SENTINEL: _"Is the unit still running, or completely off?"_ Say: **"It's running, but it's not cooling. What should we do right now?"**                                                            | Operational state: unknowns shrink, **risk signals** (system assessment)                                                                   |
| **0:35** Barge-in      | While SENTINEL is answering, **talk over it**: **"Wait, stop. I already moved the food to the bar fridge."**                                                                                       | Transcript: SENTINEL line marked **✋ interrupted**. Action **Move perishable inventory → COMPLETED**. Fact **backup storage: bar fridge** |
| **0:45** Action        | Say: **"Please get maintenance on it."**                                                                                                                                                           | **Contact maintenance → IN PROGRESS · demo simulation**, 00:30 countdown                                                                   |
| **0:50** Evidence      | Click the temperature. _"Every fact traces to the words it came from."_ **Show in conversation** jumps to the utterance.                                                                           | Provenance drawer: evidence chain Voice → Transcript → Fact → Action → Timeline                                                            |
| **1:00** Correction    | Say: **"Actually, I checked again. It says thirteen point four degrees."**                                                                                                                         | **13.4°C · ✓ CONFIRMED**, _was ~~12°C~~ SUPERSEDED_                                                                                        |
| **1:15** Escalation    | The countdown ends and SENTINEL says it: _"Ko Min hasn't responded, so I've escalated this to Maya Win."_                                                                                          | **E1 → Maya Win · DEMO SIMULATION, no real message sent**. Status **ESCALATED**. Timeline                                                  |
| **1:20** Report        | Say: **"Generate the incident report."** → **View report** (or **Replay**)                                                                                                                         | Confirmed / approximate / unverified / **unknown**, actions with "because …", escalations, timeline                                        |
| **1:30** Close         | _"SENTINEL isn't a voice chatbot. It turned what I said into evidence, found what was missing, changed the actions, handled my interruption, escalated, and can show where every fact came from."_ | —                                                                                                                                          |

> **Timing:** the escalation fires 30 s after maintenance goes in progress (demo timing; production policy is 15 min). The evidence and correction beats fill that gap naturally, and the countdown keeps running.

---

## Pitch (30 seconds)

> When something goes wrong, the first few minutes matter. But incident response still runs on forms, scattered messages and incomplete notes.
>
> SENTINEL turns a natural voice report into an evidence-backed incident response. You tell it what happened. It asks for the facts it needs, opens the incident, coordinates actions, tracks what is known and what isn't, escalates when nobody responds, and leaves a complete timeline of what was said and what was done.
>
> Every fact knows where it came from. Every estimate stays an estimate. Nothing is marked as sent unless it was.
>
> SENTINEL isn't a voice chatbot. It's a voice-operated incident response system.

## Why AssemblyAI (if asked)

- One WebSocket gives speech-in, speech-out, turn detection, **semantic barge-in** and **tool calling**. That is SENTINEL's whole interaction loop.
- Tools are revealed progressively (only `create_incident` until an incident exists), and each tool result carries live incident state back into the conversation.
- `keyterms` bias recognition toward branch names, staff names and equipment.
- The browser uses single-use temporary tokens, so the API key never leaves the server.

## If something goes wrong on stage

| Problem                         | Recovery                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The room is too noisy           | Click **Type instead** and type the lines. It's still the AssemblyAI agent, and messages are recorded as _typed_.                                                                    |
| Voice drops                     | The banner shows _VOICE CONNECTION LOST, reconnecting_. If it gives up: _"The incident data is preserved."_ Carry on with the manual controls, then **Resume by voice**.             |
| No API key or no network        | Use **Or create it manually without voice**, the fact and action forms, and **Demo simulation → Contact replies / Manager acknowledges**. Be upfront that this is the degraded mode. |
| Maintenance "replies" too early | That only happens if you click **Contact replies**. Leave the demo-simulation box alone until after the escalation.                                                                  |
