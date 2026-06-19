import {
  ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
  audioFormatStatus,
} from "../shared/telephony-audio-format.mjs";

const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

const [agent, workerHealth, twilioEvents] = await Promise.all([
  requestJson(`${apiBase}/v1/convai/agents/${agentId}`, {
    headers: { "xi-api-key": apiKey },
  }),
  requestJson(`${workerBaseUrl}/health`),
  requestJson(`${workerBaseUrl}/twilio/events?limit=50`, {
    headers: { authorization: `Bearer ${toolToken}` },
  }),
]);

const config = agent.conversation_config || {};
const audio = audioFormatStatus({
  asrFormat: config.asr?.user_input_audio_format,
  ttsFormat: config.tts?.agent_output_audio_format,
});
const events = Array.isArray(twilioEvents.events) ? twilioEvents.events : [];
const streamErrors = events.filter((event) => event.stream_error || event.stream_event === "stream-error");
const recentStops = events.filter((event) => event.stream_event === "stream-stopped");
const recentStarts = events.filter((event) => event.stream_event === "stream-started");

const ok =
  audio.asr_matches_expected &&
  audio.tts_matches_expected &&
  audio.formats_match_each_other &&
  workerHealth.expected_elevenlabs_audio_format === ELEVENLABS_TELEPHONY_AUDIO_FORMAT &&
  streamErrors.length === 0;

console.log(
  JSON.stringify(
    {
      ok,
      expected_audio_format: ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
      elevenlabs_audio: audio,
      worker_audio: {
        expected_elevenlabs_audio_format:
          workerHealth.expected_elevenlabs_audio_format || null,
      },
      recent_twilio_events: {
        returned_count: events.length,
        stream_started_count: recentStarts.length,
        stream_stopped_count: recentStops.length,
        stream_error_count: streamErrors.length,
        latest_stream_errors: streamErrors.slice(0, 5).map((event) => ({
          received_at: event.received_at,
          call_sid: event.call_sid,
          stream_sid: event.stream_sid,
          stream_error: event.stream_error,
        })),
      },
      diagnosis: ok
        ? "Audio formats are aligned on ulaw_8000 and no recent Twilio stream errors were found."
        : "Investigate audio format drift or Twilio stream errors before changing codecs.",
    },
    null,
    2
  )
);

process.exit(ok ? 0 : 2);

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const parsed = parseMaybeJson(text);

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}: ${text}`);
  }

  return parsed;
}

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
