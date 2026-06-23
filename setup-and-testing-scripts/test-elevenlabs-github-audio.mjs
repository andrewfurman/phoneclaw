import { execFile as execFileCallback } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;
const itemType = normalizeItemType(
  readArgValue("--item-type") || process.env.GITHUB_AUDIO_TEST_ITEM_TYPE || "pull_requests"
);
const question =
  itemType === "issues"
    ? "How many open GitHub issues do I have, and what are the top ones about? Please answer from GitHub. Do not read issue numbers unless I ask for them."
    : "How many open GitHub pull requests do I have, and what are the top ones about? Please answer from GitHub. Do not read pull request numbers unless I ask for them.";

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

const expected = await fetchWorkerGithubSummary(itemType);
const wavPath = await generateQuestionAudio(question);
const pcm16 = extractWavData(await readFile(wavPath));
const ulaw = pcm16le16kToUlaw8k(pcm16);
const conversation = await runAudioConversation(ulaw);
const details = await fetchConversationDetails(conversation.conversationId);
const verification = verifyConversation(details, expected);

const ok = verification.ok;
console.log(
  JSON.stringify(
    {
      ok,
      conversation_id: conversation.conversationId,
      item_type: itemType,
      expected_total_count: expected.total_count,
      tool_total_count: verification.toolTotalCount,
      user_transcript: conversation.userTranscript,
      agent_response_preview: verification.agentResponse.slice(0, 700),
      checks: verification.checks,
    },
    null,
    2
  )
);
process.exit(ok ? 0 : 1);

async function generateQuestionAudio(text) {
  const directory = await mkdtemp(join(tmpdir(), "phoneclaw-github-audio-"));
  const wavPath = join(directory, "question.wav");

  await execFile("/usr/bin/say", [
    "-v",
    "Alex",
    "-r",
    "170",
    "-o",
    wavPath,
    "--file-format=WAVE",
    "--data-format=LEI16@16000",
    "--channels=1",
    text,
  ]);

  return wavPath;
}

async function fetchWorkerGithubSummary(itemType) {
  const response = await fetch(`${workerBaseUrl}/github-summary`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${toolToken}`,
    },
    body: JSON.stringify({
      item_type: itemType,
      scope: "involved",
      max_results: 5,
    }),
  });
  const body = await response.json();

  if (!response.ok || !body.ok) {
    throw new Error(
      `Worker GitHub summary failed (${response.status}): ${JSON.stringify(body)}`
    );
  }

  return body;
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
  let streamed = false;
  let sawToolResponse = false;
  let done;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  let settleTimer;
  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 90_000);
  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => done({ reason: "settled" }), 6_500);
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
      return;
    }

    if (message.type === "agent_response") {
      const text = message.agent_response_event?.agent_response || "";
      if (!streamed && /what can i help/i.test(text)) {
        streamed = true;
        setTimeout(() => {
          streamUlawAudio(ws, ulawAudio).catch((error) =>
            done({ reason: "stream_error", error: String(error) })
          );
        }, 2_200);
      }
      if (sawToolResponse) settle();
      return;
    }

    if (message.type === "user_transcript") {
      const text = message.user_transcription_event?.user_transcript || "";
      if (text) userTranscripts.push(text);
      return;
    }

    if (message.type === "agent_tool_response") {
      sawToolResponse = true;
    }
  });

  ws.addEventListener("error", () => done({ reason: "websocket_error" }));

  await donePromise;
  clearTimeout(hardTimeout);
  clearTimeout(settleTimer);
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

async function streamUlawAudio(socket, buffer) {
  const chunkSize = 800;
  const silence = Buffer.alloc(chunkSize, 0xff);

  for (let i = 0; i < 5; i += 1) {
    socket.send(JSON.stringify({ user_audio_chunk: silence.toString("base64") }));
    await wait(100);
  }

  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    const chunk = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
    socket.send(JSON.stringify({ user_audio_chunk: chunk.toString("base64") }));
    await wait(100);
  }

  for (let i = 0; i < 14; i += 1) {
    socket.send(JSON.stringify({ user_audio_chunk: silence.toString("base64") }));
    await wait(100);
  }
}

async function fetchConversationDetails(conversationId) {
  const deadline = Date.now() + 45_000;
  let last;

  while (Date.now() < deadline) {
    last = await requestJson(`${apiBase}/v1/convai/conversations/${conversationId}`);
    if (conversationHasPostToolAnswer(last)) return last;
    await wait(1_500);
  }

  return last;
}

function conversationHasPostToolAnswer(details) {
  const transcript = details?.transcript || [];
  const toolResultIndex = transcript.findIndex((turn) =>
    (turn.tool_results || []).some((result) => result.tool_name === "github_summary")
  );
  if (toolResultIndex < 0) return false;
  return transcript
    .slice(toolResultIndex + 1)
    .some((turn) => turn.role === "agent" && isRealAgentMessage(turn.message));
}

function verifyConversation(details, expected) {
  const transcript = details.transcript || [];
  const toolCall = transcript
    .flatMap((turn) => turn.tool_calls || [])
    .find((call) => call.tool_name === "github_summary");
  const toolResult = transcript
    .flatMap((turn) => turn.tool_results || [])
    .find((result) => result.tool_name === "github_summary");
  const resultValue = parseMaybeJson(toolResult?.result_value);
  const params = parseMaybeJson(toolCall?.params_as_json);
  const returnedItems = Array.isArray(resultValue?.items) ? resultValue.items : [];
  const hasReturnedItems = returnedItems.length > 0;
  const toolResultIndex = transcript.findIndex((turn) =>
    (turn.tool_results || []).some((result) => result.tool_name === "github_summary")
  );
  const agentResponse =
    transcript
      .slice(Math.max(0, toolResultIndex + 1))
      .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
      .map((turn) => turn.message)
      .at(-1) || "";

  const checks = {
    transcribed_github_question: transcript.some((turn) =>
      String(turn.message || "")
        .toLowerCase()
        .includes(itemType === "issues" ? "github issues" : "github pull requests")
    ),
    used_github_summary_tool: Boolean(toolCall),
    requested_expected_item_type: params?.item_type === itemType,
    tool_returned_without_error: Boolean(toolResult) && toolResult.is_error === false,
    tool_count_matches_worker: resultValue?.total_count === expected.total_count,
    tool_answer_omits_item_numbers:
      !hasReturnedItems || !containsSpokenGithubNumber(resultValue?.answer_text),
    tool_items_include_spoken_summaries:
      !hasReturnedItems ||
      returnedItems.every((item) => twoToFourWordSummary(item.spoken_summary)),
    agent_answered_after_tool: agentResponse.length > 0,
    agent_omitted_item_numbers:
      !hasReturnedItems || !containsSpokenGithubNumber(agentResponse),
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    toolTotalCount: resultValue?.total_count,
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

function isRealAgentMessage(value) {
  const text = String(value || "").trim();
  return text.length > 5 && text !== "...";
}

function containsSpokenGithubNumber(value) {
  const text = String(value || "").toLowerCase();
  return /#\d+|(?:^|\n)\s*\d+\.|\b(issue|pull request|pr)\s+number\s+\d+\b/.test(text);
}

function twoToFourWordSummary(value) {
  const words = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length >= 2 && words.length <= 4;
}

function normalizeItemType(value) {
  const normalized = String(value || "").toLowerCase().replaceAll("-", "_");
  if (["issue", "issues"].includes(normalized)) return "issues";
  return "pull_requests";
}

function readArgValue(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
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
