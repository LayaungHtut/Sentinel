# Draft support report: `session.resume` always returns `session_not_found`

_Draft for the SENTINEL team to send to AssemblyAI support. Review it, then send it from the account that owns the API key. Session IDs are included because support will need them. Nothing here contains a credential._

---

**Product:** Voice Agent API (`wss://agents.assemblyai.com/v1/ws`)
**Summary:** After an abrupt disconnect (no `session.end`), reconnecting and sending `session.resume` with the `session_id` from `session.ready` is rejected every time with `session.error` `session_not_found` ("Session not found or grace window has expired"). This happens even 1 second after the drop, well inside the documented grace window.

### Reproduction (minimal, server-side, Bearer auth)

1. Open `wss://agents.assemblyai.com/v1/ws` with `Authorization: Bearer <API key>`.
2. Send `{"type":"session.update","session":{"system_prompt":"You are a connectivity probe. Say nothing unless asked."}}`.
3. Receive `session.ready`; record `session_id`.
4. Terminate the TCP connection without sending `session.end`.
5. Wait _N_ seconds, open a new connection with the same header, and send `{"type":"session.resume","session_id":"<id>"}`.
6. Observe `{"type":"session.error","code":"session_not_found","message":"Session not found or grace window has expired"}`.

Script: `scripts/live-resume.mjs` in our repository (`node --env-file=.env scripts/live-resume.mjs --delays 1,5,15`).

### Observations (2026-09-25, UTC)

| Delay before resume | Session ID                              | Result                              |
| ------------------- | --------------------------------------- | ----------------------------------- |
| 1 s                 | `sess_e70e861560fb499fa4abe7316f21d3d8` | `session.error` `session_not_found` |
| 5 s                 | `sess_147a58cc6c4e4559b4d0a9ee25347fca` | `session.error` `session_not_found` |
| 15 s                | `sess_43c719af8d374a9ba058be62d759409d` | `session.error` `session_not_found` |

On 2026-09-24 the same behaviour occurred in 5 of 5 attempts using browser temporary tokens (a fresh single-use token per connection). The failure is therefore independent of the authentication method.

### Questions

1. Is `session.resume` currently supported on the Voice Agent API, and what is the grace window?
2. Must the resume connection meet any condition we're missing (same region or endpoint, a header, a delay, or sending `session.end` first)?
3. Does an abrupt TCP close end the session immediately on your side, and is there a way to keep it resumable?

### Impact and workaround

SENTINEL keeps the incident record in its own database. On a failed resume it opens a new session and rebuilds the prompt from that record, so users lose the agent's short-term conversational memory but no data. Working resume would make reconnects seamless.
