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

For voice calls, keep the default response compact: `max_results=3` and Tavily `TAVILY_SEARCH_DEPTH=fast`. The web search response also includes a lightweight market-data enrichment for WTI/West Texas crude oil price questions.

## GitHub Summary Tool

`Andrew Assistant Agent` can also use `github_summary`, an authenticated webhook tool that returns read-only summaries of open GitHub issues and pull requests visible to the GitHub CLI account authenticated on the private EC2 bridge.

`github_summary` supports optional `repo`, `organization`, and `owner` filters. Use `repo` in `owner/name` format when Andrew asks about a specific repository.

## GitHub CLI-Style File Tools

`Andrew Assistant Agent` also has two read-only GitHub CLI-style webhook tools:

- `github_cli_ls` lists a repository root, a folder, or a recursive tree.
- `github_cli_cat` reads the full contents of a specific file path, subject to the tool's `max_bytes` cap.

These tools return a `gh_equivalent` field such as `gh api repos/OWNER/REPO/contents/PATH`. The public Worker does not execute shell commands; it proxies to the private bridge, which executes fixed `gh` commands with the bridge service user's authenticated GitHub CLI session.

## GitHub Issue Write Tools

`Andrew Assistant Agent` has issue-only write tools:

- `github_issue_create` creates a new issue.
- `github_issue_update` updates an existing issue's title, body, state, labels, or assignees.

Both tools require `confirmed=true`. The agent prompt instructs the model to use that only after Andrew explicitly confirms the exact repository and issue change by voice.

Issue writes use the same bridge-side `gh` session, so private and organization access depends on that account's repository access, SSO authorization, and org policy.

Attach or refresh the live ElevenLabs tool definitions with:

```bash
npm run elevenlabs:github:configure
```

The configured webhook tools use ElevenLabs' `typing` tool-call sound with `pre_tool_speech=auto` for slower search, GitHub, email, and Otter operations. The agent prompt also tells the model to say a brief status phrase before slow calls.

Export a public-safe snapshot of the live agent and tools with:

```bash
npm run elevenlabs:agent:export
```

Run the live ElevenLabs GitHub tool test with:

```bash
npm run elevenlabs:github:test
```

The test opens real ElevenLabs WebSocket conversations, asks issue and pull request questions, then verifies the stored transcripts include successful `github_summary` tool calls.

Run the live file-tool test with:

```bash
npm run elevenlabs:github:files:test
```

By default this uses the public `andrewfurman/phoneclaw` repo. Override `GITHUB_FILES_TEST_REPO` and `GITHUB_FILES_TEST_FILE` locally to test private repos.

## Email Forwarding Tool

`Andrew Assistant Agent` has a confirmation-gated `himalaya_email_forward` webhook tool. It saves a Gmail/Himalaya forward draft for an existing envelope id, includes Andrew's optional message above the forwarded email, and preserves the original HTML inline when available without attaching the original `.eml`.

The tool does not send email. The agent should use `himalaya_email_list` and `himalaya_email_read` first to identify the exact source email, then verbally confirm the recipient and message before calling `himalaya_email_forward` with `confirmed=true`.

## Emergency Email Send Tool

`himalaya_email_send` is emergency-only and requires the agent to preview the exact recipient, subject, and body before asking for a second confirmation. Run the live conversation test with:

```bash
npm run elevenlabs:email-send:test
```

The test sends a small validation email to `EMAIL_SEND_TEST_TO`, defaulting to Andrew's Gmail account.

## Voice Stability

The agent uses Jessi (`wfJ7pHCS3lXZdaz77rIG`) as its single configured voice. Multi-voice support remains empty, runtime voice overrides remain disabled, and `setup-and-testing-scripts/configure-elevenlabs-github-tools.mjs` enforces conservative TTS settings: stability `0.75`, similarity boost `0.9`, and speed `1`.

These settings are meant to reduce mid-call voice drift while keeping the same selected voice. If voice drift returns, first check that the exported agent config still has `supported_voices: []`, the same `voice_id`, and voice overrides disabled under platform settings.

On macOS, run the audio-style test with:

```bash
npm run elevenlabs:github:audio:test
```

This generates a spoken GitHub pull request question with `say`, converts it to Twilio-style `ulaw_8000`, streams it into the agent, and verifies the agent transcribed the question, called `github_summary`, and answered.
