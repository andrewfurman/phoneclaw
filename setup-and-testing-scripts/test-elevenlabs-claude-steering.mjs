const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const steeringInstruction =
  "For this validation only, when you later receive a code task, first check README naming for phone-claw.";
const question = [
  "Use the claude_code tool for this validation.",
  "Start a Claude Code session.",
  `Then add this exact steering instruction to that same session: "${steeringInstruction}"`,
  "I explicitly confirm that exact steering instruction.",
  "Do not submit a Claude Code task or start a code job.",
  "After the steering tool returns, briefly say whether the steering instruction was recorded.",
].join(" ");

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

const conversation = await runConversation(question);
const details = await fetchConversationDetails(conversation.conversationId);
const verification = verifyConversation(details);

console.log(
  JSON.stringify(
    {
      ok: verification.ok,
      conversation_id: conversation.conversationId,
      conversation_status: details.status,
      session_id: verification.sessionId,
      steering_status: verification.steeringStatus,
      steering_id: verification.steeringId,
      agent_response_preview: verification.agentResponse.slice(0, 700),
      checks: verification.checks,
    },
    null,
    2
  )
);

process.exit(verification.ok ? 0 : 1);

async function runConversation(messageText) {
  const signed = await requestJson(
    `${apiBase}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
      agentId
    )}`
  );

  const ws = new WebSocket(signed.signed_url);
  let sentQuestion = false;
  let conversationId = null;
  let sawSteeringResponse = false;
  let done;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  let settleTimer;
  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 90_000);
  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => done({ reason: "settled" }), 5_000);
  };

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
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
      if (!sentQuestion) {
        sentQuestion = true;
        ws.send(JSON.stringify({ type: "user_message", text: messageText }));
      }
      return;
    }

    if (!sentQuestion) return;

    if (message.type === "agent_tool_response") {
      const toolEvent = message.agent_tool_response_event || {};
      const parsed = parseMaybeJson(toolEvent.tool_response);
      if (
        toolEvent.tool_name === "claude_code" &&
        parsed?.status === "steering_recorded"
      ) {
        sawSteeringResponse = true;
      }
      return;
    }

    if (message.type === "agent_response" && sawSteeringResponse) {
      const text = message.agent_response_event?.agent_response || "";
      if (isRealAgentMessage(text)) settle();
    }
  });

  ws.addEventListener("error", () => done({ reason: "websocket_error" }));

  const result = await donePromise;
  clearTimeout(hardTimeout);
  clearTimeout(settleTimer);
  try {
    ws.close();
  } catch {}

  if (!conversationId) {
    throw new Error(`No ElevenLabs conversation ID returned: ${JSON.stringify(result)}`);
  }

  return { conversationId };
}

async function fetchConversationDetails(conversationId) {
  const deadline = Date.now() + 60_000;
  let last;

  while (Date.now() < deadline) {
    last = await requestJson(`${apiBase}/v1/convai/conversations/${conversationId}`);
    if (conversationHasSteeringResult(last)) return last;
    await wait(1_500);
  }

  return last;
}

function conversationHasSteeringResult(details) {
  const transcript = details?.transcript || [];
  const steeringResultIndex = transcript.findLastIndex((turn) =>
    (turn.tool_results || []).some((result) => {
      const value = parseMaybeJson(result.result_value);
      return result.tool_name === "claude_code" && value?.status === "steering_recorded";
    })
  );
  if (steeringResultIndex < 0) return false;

  return transcript
    .slice(steeringResultIndex + 1)
    .some((turn) => turn.role === "agent" && isRealAgentMessage(turn.message));
}

function verifyConversation(details) {
  const transcript = details?.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const claudeCalls = toolCalls
    .filter((call) => call.tool_name === "claude_code")
    .map((call) => ({ call, params: parseMaybeJson(call.params_as_json) }));
  const claudeResults = toolResults
    .filter((result) => result.tool_name === "claude_code")
    .map((result) => ({ result, value: parseMaybeJson(result.result_value) }));
  const startCall = claudeCalls.find((item) => item.params?.action === "start_session");
  const steerCall = claudeCalls.find((item) => item.params?.action === "steer_session");
  const startResult = claudeResults.find((item) => item.value?.status === "session_ready");
  const steerResult = claudeResults.find((item) => item.value?.status === "steering_recorded");
  const submittedTask = claudeCalls.some((item) => item.params?.action === "submit_task");
  const steeringResultIndex = transcript.findLastIndex((turn) =>
    (turn.tool_results || []).some((result) => {
      const value = parseMaybeJson(result.result_value);
      return result.tool_name === "claude_code" && value?.status === "steering_recorded";
    })
  );
  const agentResponse =
    transcript
      .slice(Math.max(0, steeringResultIndex + 1))
      .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
      .map((turn) => turn.message)
      .at(-1) || "";

  const checks = {
    transcript_available: transcript.length > 0,
    used_start_session: Boolean(startCall),
    start_session_returned_without_error:
      Boolean(startResult) && startResult.result.is_error === false,
    used_steer_session: Boolean(steerCall),
    steer_session_confirmed: steerCall?.params?.confirmed === true,
    steering_instruction_matches:
      String(steerCall?.params?.instructions || "").trim() === steeringInstruction,
    steer_session_returned_without_error:
      Boolean(steerResult) && steerResult.result.is_error === false,
    same_session_used:
      Boolean(startResult?.value?.session_id) &&
      startResult.value.session_id === steerResult?.value?.session_id,
    steering_id_returned: Boolean(steerResult?.value?.steering_id),
    did_not_submit_task: !submittedTask,
    agent_answered_after_steering: agentResponse.length > 0,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    sessionId: steerResult?.value?.session_id || startResult?.value?.session_id || "",
    steeringStatus: steerResult?.value?.status || "",
    steeringId: steerResult?.value?.steering_id || "",
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

function isRealAgentMessage(value) {
  const text = String(value || "").trim();
  return text.length > 5 && text !== "...";
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
