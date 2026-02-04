# paule-relay

Twilio ConversationRelay relay server for inbound/outbound AI calls with OpenAI.

Current default profile is tuned for Lithuanian "balanced" quality:
- TTS: Google
- Voice: `lt-LT-Standard-B`
- STT: Google + `telephony`

## Endpoints

- `GET /twiml` - returns TwiML `<ConversationRelay ... />`
- `GET /health` - basic health + active config
- `GET /metrics` - structured counters (sessions, interruptions, 64101/64107, etc.)

## Environment variables

Use `.env.example` as template.

Required:
- `OPENAI_API_KEY`

Core relay configuration:
- `RELAY_LANGUAGE` (default `lt-LT`)
- `TTS_PROVIDER` (`google` or `eleven`)
- `GOOGLE_VOICE` (default `lt-LT-Standard-B`)
- `TRANSCRIPTION_PROVIDER` (default `Google`)
- `TRANSCRIPTION_LANGUAGE` (default `lt-LT`)
- `TTS_LANGUAGE` (default `lt-LT`)
- `SPEECH_MODEL` (default `telephony`)
- `INTERRUPTIBLE` (default `speech`)
- `REPORT_INPUT_DURING_AGENT_SPEECH` (default `speech`)

OpenAI:
- `OPENAI_MODEL` (default `gpt-5-mini`)
- `OPENAI_TIMEOUT_MS` (default `25000`)

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
- WebSocket supports official ConversationRelay message types:
  - `setup`, `prompt`, `interrupt`, `error`
- Prompt chunks are buffered until `last=true`.
- AI text tokens are streamed without duplicate final tokens.
- Output text is normalized for LT TTS (dates, prices, emails, URLs).
