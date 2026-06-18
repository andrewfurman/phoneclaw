# Setup Log

This log captures the prototype shape without publishing credentials or live provider identifiers.

## 2026-06-18

- Installed and verified the Twilio CLI locally.
- Verified Twilio API access against the intended personal account.
- Verified ElevenLabs API access.
- Created or selected an ElevenLabs Conversational AI agent.
- Set the ElevenLabs telephony audio formats to `ulaw_8000` for both ASR input and TTS output.
- Added a repo check that verifies the live ElevenLabs agent still has ASR and TTS audio formats set to the same `ulaw_8000` value.
- Built a local Fastify webhook that can register Twilio calls with ElevenLabs.
- Built a Cloudflare Worker version of the webhook for public hosting.
- Configured the Twilio number voice webhook to point at the Worker.
- Confirmed the phone line could reach a simple TwiML test response.
- Switched the call path back toward the ElevenLabs register-call flow.
- Added an inbound caller allow-list so only configured caller IDs reach the ElevenLabs agent.
- Added an authenticated ElevenLabs `web_search` webhook tool backed by the Worker.
- Added basic DuckDuckGo web results, a voice-friendly `answer_text` field, and prototype FIFA World Cup schedule enrichment.

## Current Prototype

The working path is:

1. Caller dials a Twilio number.
2. Twilio sends the voice webhook to the public Cloudflare Worker.
3. The Worker validates the webhook token.
4. The Worker checks the inbound caller allow-list.
5. The Worker calls ElevenLabs `register-call`.
6. ElevenLabs returns TwiML.
7. The Worker returns that TwiML to Twilio.
8. Twilio connects the live call to the ElevenLabs agent.
9. When needed, the agent can call the Worker's `web_search` tool for current information.

## Not Published

The public repository intentionally omits:

- Twilio Account SID, API keys, auth tokens, and recovery codes.
- ElevenLabs API keys.
- Cloudflare API tokens.
- Live webhook tokens.
- Local `wrangler.toml` deploy config.
- Live phone numbers and provider account IDs.
