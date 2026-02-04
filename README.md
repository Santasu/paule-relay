# paule-relay

Twilio ConversationRelay relay server for inbound/outbound AI calls with OpenAI.

Current default profile is tuned for Lithuanian "balanced" quality:
- TTS: Google
- Voice: `lt-LT-Standard-B`
- Safe TwiML mode: minimal ConversationRelay attributes (lower 64101 risk)

## Endpoints

- `GET /twiml` - returns TwiML `<ConversationRelay ... />`
- `GET /twiml-say` - returns diagnostic `<Say ...>` TwiML (no ConversationRelay)
- `GET /health` - basic health + active config
- `GET /metrics` - structured counters (sessions, interruptions, 64101/64107, etc.)
- `GET /debug?limit=120` - last structured events from in-memory debug ring buffer
- `GET /debug-log` - plain text debug log file from `/tmp` (when enabled)
- `GET /debug-log-clear` - clear debug log file

## Environment variables

Use `.env.example` as template.

Required:
- `OPENAI_API_KEY`

Core relay configuration:
- `RELAY_LANGUAGE` (default `lt-LT`)
- `TTS_PROVIDER` (`google` or `eleven`)
- `GOOGLE_VOICE` (default `lt-LT-Standard-B`)
- `ALLOW_GOOGLE_VOICE_ATTRIBUTE` (default `false`)
- `ENABLE_ADVANCED_RELAY_ATTRIBUTES` (default `false`)
- `SEND_SETUP_LANGUAGE_MESSAGE` (default `false`)
- `SEND_SETUP_GREETING_FALLBACK` (default `false`)

Optional advanced relay attributes (only when `ENABLE_ADVANCED_RELAY_ATTRIBUTES=true`):
- `TRANSCRIPTION_PROVIDER` (for example `Google` or `Deepgram`)
- `TRANSCRIPTION_LANGUAGE` (for example `lt-LT`)
- `TTS_LANGUAGE` (for example `lt-LT`)
- `SPEECH_MODEL` (for example `telephony`)
- `INTERRUPTIBLE` (for example `speech`)
- `REPORT_INPUT_DURING_AGENT_SPEECH` (for example `speech`)

OpenAI:
- `OPENAI_MODEL` (default `gpt-5-mini`)
- `OPENAI_TIMEOUT_MS` (default `25000`)
- `TWIML_MODE` (`relay`, `say`, `say_then_relay`; default `relay`)
- `SAY_DIAGNOSTIC_TEXT` (text for `say` mode)
- `DEBUG_EVENT_LIMIT` (ring buffer size, default `300`)
- `ENABLE_FILE_DEBUG_LOG` (`true`/`false`, default `false`)
- `DEBUG_LOG_PATH` (default `/tmp/paule-relay-debug.log`)

Optional ElevenLabs (stage 2 / premium):
- `ELEVEN_VOICE_ID`
- `ELEVEN_MODEL` (default `turbo_v2_5`)
- `ELEVEN_SPEED` (default `1.0`)
- `ELEVEN_STABILITY` (default `0.45`)
- `ELEVEN_SIMILARITY` (default `0.92`)

## Railway deploy checklist

1. Deploy this service on Railway.
2. Fill all variables from `.env.example`.
3. Verify:
   - `https://<railway-domain>/health`
   - `https://<railway-domain>/twiml`
4. Set Twilio Voice URL to:
   - `https://<railway-domain>/twiml`
5. Test inbound + outbound call flows.

## Notes

- The relay now uses explicit `ttsLanguage`, `transcriptionLanguage`, `transcriptionProvider`, `speechModel`.
- By default, TwiML is intentionally minimal to avoid strict attribute mismatch errors (for example 64101).
- In Google mode, `voice` attribute is disabled by default (`ALLOW_GOOGLE_VOICE_ATTRIBUTE=false`) to reduce 64101 risk.
- WebSocket supports official ConversationRelay message types:
  - `setup`, `prompt`, `interrupt`, `error`
- Prompt chunks are buffered until `last=true`.
- AI text tokens are streamed without duplicate final tokens.
- Output text is normalized for LT TTS (dates, prices, emails, URLs).

