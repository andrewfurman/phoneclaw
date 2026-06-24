const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const goodbyeMessage =
  process.env.ELEVENLABS_END_CALL_TEST_MESSAGE ||
  "That's all for now. Thanks. Goodbye.";

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

const agent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`);
const agentChecks = verifyAgentConfig(agent);
const conversation = await runTextConversation(goodbyeMessage);
const details = await fetchConversationDetails(conversation.conversationId);
const verification = verifyConversation(details, conversation);

const checks = {
  ...agentChecks,
  ...verification.checks,
};

console.log(
  JSON.stringify(
    {
      ok: Object.values(checks).every(Boolean),
      conversation_id: conversation.conversationId,
      user_message: goodbyeMessage,
      websocket_close_code: conversation.closeCode,
      websocket_close_reason: conversation.closeReason,
      websocket_message_types: conversation.messageTypes,
      max_duration_seconds:
        agent.conversation_config?.conversation?.max_duration_seconds ?? null,
      end_call_tool_call: verification.endCallToolCall,
      end_call_tool_result: verification.endCallToolResult,
      agent_response_preview: verification.agentResponse.slice(0, 700),
      conversation_status: verification.conversationStatus,
      checks,
    },
    null,
    2
  )
);

process.exit(Object.values(checks).every(Boolean) ? 0 : 1);

function verifyAgentConfig(agent) {
  const prompt = agent.conversation_config?.agent?.prompt || {};
  const builtInTools = prompt.built_in_tools || {};
  const maxDurationSeconds = Number(
    agent.conversation_config?.conversation?.max_duration_seconds
  );

  return {
    max_duration_is_two_hours: maxDurationSeconds === 7_200,
    end_call_system_tool_configured:
      Boolean(builtInTools.end_call) || builtInTools.end_call === null,
  };
}

async function runTextConversation(messageText) {
  const signed = await requestJson(
    `${apiBase}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
      agentId
    )}`
  );

  const ws = new WebSocket(signed.signed_url);
  const messageTypes = [];
  let conversationId = null;
  let sentUserMessage = false;
  let closeCode = null;
  let closeReason = "";
  let done;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 90_000);
  let settleTimer;
  const settleAfterAgentResponse = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => done({ reason: "settled_after_agent_response" }), 6_000);
  };
  const sendUserMessage = () => {
    if (sentUserMessage) return;
    sentUserMessage = true;
    ws.send(JSON.stringify({ type: "user_message", text: messageText }));
  };

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
  });

  ws.addEventListener("message", (event) => {
    const message = parseMaybeJson(event.data);
    if (!message || typeof message !== "object") return;
    if (message.type) messageTypes.push(message.type);

    if (message.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", event_id: message.ping_event?.event_id }));
      return;
    }

    if (message.type === "conversation_initiation_metadata") {
      conversationId =
        message.conversation_initiation_metadata_event?.conversation_id || null;
      setTimeout(sendUserMessage, 500);
      return;
    }

    if (
      sentUserMessage &&
      (message.type === "agent_response" || message.type === "agent_response_complete")
    ) {
      settleAfterAgentResponse();
    }
  });

  ws.addEventListener("close", (event) => {
    closeCode = event.code;
    closeReason = event.reason || "";
    done({ reason: "websocket_closed" });
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
    closeCode,
    closeReason,
    messageTypes: [...new Set(messageTypes)],
  };
}

async function fetchConversationDetails(conversationId) {
  const deadline = Date.now() + 75_000;
  let last;

  while (Date.now() < deadline) {
    last = await requestJson(
      `${apiBase}/v1/convai/conversations/${encodeURIComponent(conversationId)}`
    );
    const verification = verifyConversation(last, {});
    if (verification.checks.end_call_invoked && verification.checks.conversation_finished) {
      return last;
    }
    await wait(1_500);
  }

  return last || {};
}

function verifyConversation(details, conversation) {
  const transcript = details?.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const endCallToolCall = toolCalls.find((call) => call.tool_name === "end_call") || null;
  const endCallToolResult =
    toolResults.find((result) => result.tool_name === "end_call") || null;
  const agentResponse =
    transcript
      .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
      .map((turn) => turn.message)
      .at(-1) || "";
  const status = String(details?.status || details?.analysis?.call_successful || "");
  const closeCode = Number(conversation?.closeCode);

  const checks = {
    transcript_available: transcript.length > 0,
    end_call_invoked: Boolean(endCallToolCall || endCallToolResult),
    agent_said_goodbye: /bye|goodbye|talk soon|sounds good|take care/i.test(agentResponse),
    websocket_closed_or_conversation_finished:
      closeCode > 0 || ["done", "ended", "completed", "success"].includes(status.toLowerCase()),
    conversation_finished:
      ["done", "ended", "completed", "success"].includes(status.toLowerCase()) ||
      Boolean(details?.metadata?.termination_reason) ||
      Boolean(endCallToolCall || endCallToolResult),
  };

  return {
    checks,
    endCallToolCall: summarizeToolItem(endCallToolCall),
    endCallToolResult: summarizeToolItem(endCallToolResult),
    agentResponse,
    conversationStatus: details?.status || null,
  };
}

function summarizeToolItem(item) {
  if (!item) return null;
  return {
    tool_name: item.tool_name || item.name || "",
    is_error: item.is_error ?? null,
    params: parseMaybeJson(item.params_as_json),
    result: parseMaybeJson(item.result_value),
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
  return text.length > 2 && text !== "...";
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
