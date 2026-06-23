import { execFile as execFileCallback } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const runCount = clampInteger(
  readArgValue("--runs") || process.env.ECONOMIST_AUDIO_TEST_RUNS,
  1,
  5,
  1
);
const question =
  "Use your configured RSS tools. Get the five latest article titles from the configured Economist feed and get the full text for the first latest article. In your final answer, start by saying whether the tool returned full text and name the source, then list the five titles.";
const RSS_TOOL_NAMES = [
  "rss_recent_entries",
  "rss_get_article_text",
];

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

const wavPath = await generateQuestionAudio(question);
const pcm16 = extractWavData(await readFile(wavPath));
const ulaw = pcm16le16kToUlaw8k(pcm16);
const results = [];

for (let index = 0; index < runCount; index += 1) {
  const conversation = await runAudioConversation(ulaw);
  const details = await fetchConversationDetails(conversation.conversationId);
  const verification = verifyConversation(details, conversation.userTranscript);
  results.push({
    run: index + 1,
    ok: verification.ok,
    conversation_id: conversation.conversationId,
    user_transcript: conversation.userTranscript,
    recent_count: verification.recentCount,
    article_entry_id: verification.articleEntryId,
    article_title: verification.articleTitle,
    article_content_source: verification.articleContentSource,
    article_full_text_chars: verification.articleFullTextChars,
    article_access_note: verification.articleAccessNote,
    answer_text: verification.articleAnswerText,
    agent_response_preview: verification.agentResponse.slice(0, 900),
    checks: verification.checks,
  });
}

const ok = results.every((result) => result.ok);
console.log(JSON.stringify({ ok, run_count: runCount, results }, null, 2));
process.exit(ok ? 0 : 1);

async function generateQuestionAudio(text) {
  const directory = await mkdtemp(join(tmpdir(), "phoneclaw-economist-audio-"));
  const wavPath = join(directory, "question.wav");

  await execFile("/usr/bin/say", [
    "-v",
    "Alex",
    "-r",
    "165",
    "-o",
    wavPath,
    "--file-format=WAVE",
    "--data-format=LEI16@16000",
    "--channels=1",
    text,
  ]);

  return wavPath;
}

async function runAudioConversation(ulawAudio) {
  const signed = await requestJson(
    `${apiBase}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
      agentId
    )}`
  );

  const ws = new WebSocket(signed.signed_url);
  const userTranscripts = [];
  let conversationId = null;
  let speechStarted = false;
  let articleToolResultSeen = false;
  let agentResponseAfterArticleSeen = false;
  let stopAudio = false;
  let done;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });
  let settleTimer;
  let speechFallbackTimer;
  let apiPollTimer;

  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 180_000);
  const settle = (delay = 10_000) => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => done({ reason: "settled" }), delay);
  };
  const startSpeech = () => {
    speechStarted = true;
  };

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "conversation_initiation_client_data",
        conversation_config_override: {
          asr: { user_input_audio_format: "ulaw_8000" },
          tts: { agent_output_audio_format: "ulaw_8000" },
        },
      })
    );
    streamFramedUlawAudio({
      socket: ws,
      speech: ulawAudio,
      shouldStartSpeech: () => speechStarted,
      shouldStop: () => stopAudio,
    }).catch((error) => done({ reason: "stream_error", error: String(error) }));
  });

  ws.addEventListener("message", (event) => {
    const message = parseMaybeJson(event.data);
    if (!message || typeof message !== "object") return;

    if (message.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", event_id: message.ping_event?.event_id }));
      return;
    }

    if (message.type === "conversation_initiation_metadata") {
      conversationId =
        message.conversation_initiation_metadata_event?.conversation_id || null;
      clearTimeout(speechFallbackTimer);
      speechFallbackTimer = setTimeout(startSpeech, 4_500);
      apiPollTimer = setInterval(() => {
        pollConversationForCompletion(conversationId)
          .then((completed) => {
            if (completed) settle(2_000);
          })
          .catch(() => {});
      }, 2_000);
      return;
    }

    if (message.type === "agent_response") {
      const text = message.agent_response_event?.agent_response || "";
      if (!speechStarted && /what can i help|help you/i.test(text)) {
        clearTimeout(speechFallbackTimer);
        speechFallbackTimer = setTimeout(startSpeech, 1_400);
      }
      if (articleToolResultSeen && isRealAgentMessage(text)) {
        agentResponseAfterArticleSeen = true;
      }
      return;
    }

    if (message.type === "agent_response_complete") {
      if (articleToolResultSeen && agentResponseAfterArticleSeen) settle(3_000);
      return;
    }

    if (message.type === "user_transcript") {
      const text = message.user_transcription_event?.user_transcript || "";
      if (text) userTranscripts.push(text);
      return;
    }

    if (message.type === "agent_tool_response") {
      const eventBody = message.agent_tool_response_event || {};
      const toolName = eventBody.tool_name || message.tool_name || "";
      if (!toolName || toolName === "rss_get_article_text") {
        articleToolResultSeen = true;
        settle(60_000);
      }
    }
  });

  ws.addEventListener("error", () => done({ reason: "websocket_error" }));

  await donePromise;
  stopAudio = true;
  clearTimeout(hardTimeout);
  clearTimeout(settleTimer);
  clearTimeout(speechFallbackTimer);
  clearInterval(apiPollTimer);
  await wait(250);
  try {
    ws.close();
  } catch {}

  if (!conversationId) {
    throw new Error("No ElevenLabs conversation ID returned.");
  }

  return {
    conversationId,
    userTranscript: userTranscripts.join(" "),
  };
}

async function pollConversationForCompletion(conversationId) {
  if (!conversationId) return false;
  const details = await requestJson(
    `${apiBase}/v1/convai/conversations/${encodeURIComponent(conversationId)}`
  );
  const verification = verifyConversation(details, "");
  return verification.ok;
}

async function streamFramedUlawAudio({
  socket,
  speech,
  shouldStartSpeech,
  shouldStop,
}) {
  const chunkSize = 800;
  const silence = Buffer.alloc(chunkSize, 0xff);
  let speechOffset = 0;
  let trailingSilenceChunks = 18;

  while (!shouldStop()) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const started = shouldStartSpeech();
    const sendSpeech = started && speechOffset < speech.length;
    if (started && !sendSpeech && trailingSilenceChunks <= 0) return;

    const chunk = sendSpeech
      ? speech.subarray(speechOffset, Math.min(speechOffset + chunkSize, speech.length))
      : silence;

    socket.send(JSON.stringify({ user_audio_chunk: chunk.toString("base64") }));
    if (sendSpeech) speechOffset += chunk.length;
    if (started && !sendSpeech) trailingSilenceChunks -= 1;
    await wait(100);
  }
}

async function fetchConversationDetails(conversationId) {
  const deadline = Date.now() + 90_000;
  let last;

  while (Date.now() < deadline) {
    last = await requestJson(
      `${apiBase}/v1/convai/conversations/${encodeURIComponent(conversationId)}`
    );
    if (verifyConversation(last, "").ok) return last;
    if (
      last?.status === "done" &&
      conversationHasRssToolResults(last, { requireAgentAfterTool: true })
    ) {
      return last;
    }
    await wait(1_500);
  }

  return last;
}

function conversationHasRssToolResults(
  details,
  { requireAgentAfterTool = false } = {}
) {
  const transcript = details?.transcript || [];
  const toolResultNames = new Set(
    transcript.flatMap((turn) => (turn.tool_results || []).map((result) => result.tool_name))
  );
  const latestToolIndex = transcript.findLastIndex((turn) =>
    (turn.tool_results || []).some((result) => RSS_TOOL_NAMES.includes(result.tool_name))
  );
  const hasAgentAfterTool = transcript
    .slice(Math.max(0, latestToolIndex + 1))
    .some(
      (turn) =>
        turn.role === "agent" &&
        isRealAgentMessage(turn.message) &&
        !isSilenceProbe(turn.message)
    );

  return (
    RSS_TOOL_NAMES.every((toolName) => toolResultNames.has(toolName)) &&
    (!requireAgentAfterTool || hasAgentAfterTool)
  );
}

function verifyConversation(details, userTranscript) {
  const transcript = details?.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const callsByName = new Map(toolCalls.map((call) => [call.tool_name, call]));
  const resultsByName = new Map(toolResults.map((result) => [result.tool_name, result]));
  const recentResult = parseMaybeJson(resultsByName.get("rss_recent_entries")?.result_value);
  const articleResult = parseMaybeJson(resultsByName.get("rss_get_article_text")?.result_value);
  const latestToolIndex = transcript.findLastIndex((turn) =>
    (turn.tool_results || []).some((result) => RSS_TOOL_NAMES.includes(result.tool_name))
  );
  const agentMessagesAfterTool = transcript
    .slice(Math.max(0, latestToolIndex + 1))
    .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
    .map((turn) => turn.message);
  const agentResponse =
    agentMessagesAfterTool.filter((message) => !isSilenceProbe(message)).at(-1) ||
    agentMessagesAfterTool.at(-1) ||
    "";
  const recentItems = Array.isArray(recentResult?.items) ? recentResult.items : [];
  const articleTextChars = Number(articleResult?.full_text_chars || 0);
  const fullArticleAvailable =
    [
      "economist_rss_bridge",
      "feed_content_encoded",
      "feed_content",
      "original_article_fetch",
      "economist_browser_fetch",
      "stored_entry_content",
    ].includes(articleResult?.content_source) &&
    articleTextChars >= 700 &&
    !articleResult?.access_note;

  const checks = {
    transcript_available: transcript.length > 0,
    transcribed_economist_question: String(
      userTranscript || transcript.map((turn) => turn.message).join(" ")
    )
      .toLowerCase()
      .includes("economist"),
    used_recent_tool: callsByName.has("rss_recent_entries"),
    used_article_text_tool: callsByName.has("rss_get_article_text"),
    recent_tool_returned_without_error:
      resultsByName.has("rss_recent_entries") &&
      resultsByName.get("rss_recent_entries").is_error === false,
    article_text_tool_returned_without_error:
      resultsByName.has("rss_get_article_text") &&
      resultsByName.get("rss_get_article_text").is_error === false,
    recent_returned_latest_items: recentItems.length >= 5,
    article_text_returned_full_text: articleResult?.ok === true && fullArticleAvailable,
    answer_text_confirms_full_text:
      fullArticleAvailable ||
      String(articleResult?.answer_text || "").toLowerCase().includes("full article text"),
    agent_answered_after_tools: agentResponse.length > 0,
    agent_said_full_text: /full text|full article|complete/i.test(agentResponse),
    agent_did_not_call_it_paywall_preview:
      !/(paywall|preview|excerpt only|only an excerpt|login|free trial)/i.test(agentResponse),
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    recentCount: recentItems.length,
    articleEntryId: articleResult?.entry_id || null,
    articleTitle: articleResult?.entry?.title || "",
    articleContentSource: articleResult?.content_source || "",
    articleFullTextChars: articleTextChars,
    articleAccessNote: articleResult?.access_note || "",
    articleAnswerText: articleResult?.answer_text || "",
    agentResponse,
  };
}

async function requestJson(url) {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey,
    },
  });
  const text = await response.text();
  const parsed = parseMaybeJson(text);

  if (!response.ok) {
    throw new Error(`ElevenLabs request failed (${response.status}): ${text}`);
  }

  return parsed;
}

function extractWavData(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") return buffer.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAVE data chunk not found.");
}

function pcm16le16kToUlaw8k(buffer) {
  const samples = [];
  for (let offset = 0; offset + 3 < buffer.length; offset += 4) {
    const first = buffer.readInt16LE(offset);
    const second = buffer.readInt16LE(offset + 2);
    samples.push(linearToUlaw((first + second) >> 1));
  }
  return Buffer.from(samples);
}

function linearToUlaw(sample) {
  const bias = 0x84;
  const clip = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > clip) sample = clip;
  sample += bias;

  let exponent = 7;
  for (
    let exponentMask = 0x4000;
    (sample & exponentMask) === 0 && exponent > 0;
    exponent -= 1, exponentMask >>= 1
  ) {}

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function readArgValue(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function isRealAgentMessage(value) {
  const text = String(value || "").trim();
  return text.length > 5 && text !== "...";
}

function isSilenceProbe(value) {
  return /are you still there|i am still here|i'm still here|microphone is muted|if you can hear me|if you are trying to speak|if you need me/i.test(
    String(value || "")
  );
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
