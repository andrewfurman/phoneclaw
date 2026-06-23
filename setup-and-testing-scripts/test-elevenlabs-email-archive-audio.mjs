import { execFile as execFileCallback } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const question =
  "Use the Himalaya email archive tool for a validation dry run. Try to archive two fake envelope IDs validation-a and validation-b from INBOX with confirmed false, and tell me whether the tool asks for confirmation for two selected emails.";

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

const wavPath = await generateQuestionAudio(question);
const pcm16 = extractWavData(await readFile(wavPath));
const ulaw = pcm16le16kToUlaw8k(pcm16);
const conversation = await runAudioConversation(ulaw);
const details = await fetchConversationDetails(conversation.conversationId);
const verification = verifyConversation(details);

console.log(
  JSON.stringify(
    {
      ok: verification.ok,
      conversation_id: conversation.conversationId,
      user_transcript: conversation.userTranscript,
      agent_response_preview: verification.agentResponse.slice(0, 700),
      checks: verification.checks,
      tool_result: verification.toolResultSummary,
    },
    null,
    2
  )
);
process.exit(verification.ok ? 0 : 1);

async function generateQuestionAudio(text) {
  const directory = await mkdtemp(join(tmpdir(), "phoneclaw-email-archive-audio-"));
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
  let sawArchiveToolResponse = false;
  let streamTimer;
  let done;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  let settleTimer;
  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 90_000);
  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => done({ reason: "settled" }), 7_000);
  };
  const startStreaming = () => {
    if (streamed) return;
    streamed = true;
    streamUlawAudio(ws, ulawAudio).catch((error) =>
      done({ reason: "stream_error", error: String(error) })
    );
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
      clearTimeout(streamTimer);
      streamTimer = setTimeout(startStreaming, 3_500);
      return;
    }

    if (message.type === "agent_response") {
      const text = message.agent_response_event?.agent_response || "";
      if (!streamed && /what can i help|how can i help/i.test(text)) {
        clearTimeout(streamTimer);
        streamTimer = setTimeout(startStreaming, 2_200);
      }
      if (sawArchiveToolResponse) settle();
      return;
    }

    if (message.type === "user_transcript") {
      const text = message.user_transcription_event?.user_transcript || "";
      if (text) userTranscripts.push(text);
      return;
    }

    if (message.type === "agent_tool_response") {
      const toolName = message.agent_tool_response_event?.tool_name || "";
      if (toolName === "himalaya_email_archive" || !toolName) sawArchiveToolResponse = true;
    }
  });

  ws.addEventListener("error", () => done({ reason: "websocket_error" }));

  await donePromise;
  clearTimeout(hardTimeout);
  clearTimeout(settleTimer);
  clearTimeout(streamTimer);
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

  for (let i = 0; i < 12; i += 1) {
    socket.send(JSON.stringify({ user_audio_chunk: silence.toString("base64") }));
    await wait(100);
  }
}

async function fetchConversationDetails(conversationId) {
  const deadline = Date.now() + 45_000;
  let last;

  while (Date.now() < deadline) {
    last = await requestJson(`${apiBase}/v1/convai/conversations/${conversationId}`);
    if (conversationHasPostArchiveAnswer(last)) return last;
    await wait(1_500);
  }

  return last;
}

function conversationHasPostArchiveAnswer(details) {
  const transcript = details?.transcript || [];
  const toolResultIndex = transcript.findIndex((turn) =>
    (turn.tool_results || []).some((result) => result.tool_name === "himalaya_email_archive")
  );
  if (toolResultIndex < 0) return false;
  return transcript
    .slice(toolResultIndex + 1)
    .some((turn) => turn.role === "agent" && isRealAgentMessage(turn.message));
}

function verifyConversation(details) {
  const transcript = details.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const archiveToolCall = toolCalls.find((call) => call.tool_name === "himalaya_email_archive");
  const archiveToolResult = transcript
    .flatMap((turn) => turn.tool_results || [])
    .find((result) => result.tool_name === "himalaya_email_archive");
  const params = parseMaybeJson(archiveToolCall?.params_as_json);
  const resultValue = parseMaybeJson(archiveToolResult?.result_value);
  const ids = Array.isArray(params?.ids)
    ? params.ids
    : Array.isArray(params?.envelope_ids)
      ? params.envelope_ids
      : [];
  const normalizedIds = ids.map(normalizeIdForSpeech);
  const toolResultIndex = transcript.findIndex((turn) =>
    (turn.tool_results || []).some((result) => result.tool_name === "himalaya_email_archive")
  );
  const agentResponse =
    transcript
      .slice(Math.max(0, toolResultIndex + 1))
      .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
      .map((turn) => turn.message)
      .at(-1) || "";

  const checks = {
    transcript_available: transcript.length > 0,
    transcribed_archive_request: transcript.some((turn) =>
      String(turn.message || "").toLowerCase().includes("archive")
    ),
    used_email_archive_tool: Boolean(archiveToolCall),
    requested_two_ids_in_one_call:
      normalizedIds.includes("validationa") &&
      normalizedIds.includes("validationb") &&
      ids.length === 2,
    requested_unconfirmed_dry_run: params?.confirmed === false,
    tool_returned_confirmation:
      Boolean(archiveToolResult) &&
      archiveToolResult.is_error === false &&
      resultValue?.status === "confirmation_required" &&
      /2 selected emails/.test(resultValue?.answer_text || ""),
    agent_answered_after_tool: agentResponse.length > 0,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    agentResponse,
    toolResultSummary: {
      is_error: archiveToolResult?.is_error,
      status: resultValue?.status,
      answer_text: resultValue?.answer_text,
      params,
    },
  };
}

function isRealAgentMessage(value) {
  const text = String(value || "").trim();
  return text.length > 5 && text !== "...";
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

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeIdForSpeech(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
