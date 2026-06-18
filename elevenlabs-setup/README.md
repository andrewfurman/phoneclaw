# ElevenLabs Setup

## Agent

Create or select a Conversational AI agent in ElevenLabs.

The current public-safe snapshot for `Andrew Assistant Agent` is stored in:

```text
elevenlabs-setup/andrew-assistant-agent.config.json
```

For Twilio telephony through the register-call flow, configure audio formats as:

- ASR user input audio format: `ulaw_8000`
- TTS agent output audio format: `ulaw_8000`

The app treats `ulaw_8000` as the single expected telephony audio format. This keeps the caller audio coming from Twilio and the agent audio going back to Twilio in the same codec/sample-rate family.

## Required Secret

Set the API key locally in `.env`:

```bash
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=agent_...
```

For Cloudflare Workers, store the API key as a Worker secret:

```bash
wrangler secret put ELEVENLABS_API_KEY
```

Keep the agent ID in local deploy config or environment variables. It is not an API secret, but avoid committing live operational identifiers in public examples.

## Verify Audio Format

Check the live agent:

```bash
npm run elevenlabs:audio:check
```

If the agent drifts, patch both ASR and TTS formats back to `ulaw_8000`:

```bash
npm run elevenlabs:audio:fix
```

## Tool Call Starter

`send_claude_command.json` is a starter ElevenLabs webhook tool config for the future Claude Code bridge.

Before enabling it against a real command bridge:

- Require verbal confirmation.
- Authenticate every request.
- Send jobs to a supervised worker, not directly to a shell.
- Keep pushes, deletes, migrations, and deploys behind explicit approval.

## Web Search Tool

`Andrew Assistant Agent` has a webhook tool named `web_search` attached. It points at the hosted `/web-search` endpoint and is authenticated with `WEB_SEARCH_TOKEN`.

The agent prompt tells the model to use `web_search` for current events, recent facts, schedules, sports, companies, products, docs, or anything that may have changed. The tool returns structured results and a compact `answer_text` field that the agent should prefer for spoken answers.
