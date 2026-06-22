const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const sendTo = process.env.EMAIL_SEND_TEST_TO || "aifurman@gmail.com";
const testStamp = new Date().toISOString().replace(/[:.]/g, "-");
const subject = `Phoneclaw emergency send validation ${testStamp}`;
const body = "Phoneclaw automated ElevenLabs validation: emergency send path test.";
const question = `Please prepare an emergency email to ${sendTo}. The subject is "${subject}". The body is "${body}". Please read me the exact preview and ask for final confirmation before sending.`;

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
      subject,
      agent_response_preview: verification.agentResponse.slice(0, 700),
      checks: verification.checks,
      tool_result: verification.toolResultSummary,
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
  let sentFinalConfirmation = false;
  let sawSendToolResponse = false;
  let conversationId = null;
  let postToolAgentResponse = "";
  let done;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  let settleTimer;
  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 90_000);
  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => done({ reason: "settled" }), 5_500);
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
      const toolName = message.agent_tool_response_event?.tool_name || "";
      if (toolName === "himalaya_email_send") {
        sawSendToolResponse = true;
      }
      return;
    }

    if (message.type === "agent_response") {
      const text = message.agent_response_event?.agent_response || "";
      if (
        !sentFinalConfirmation &&
        !sawSendToolResponse &&
        /\bemergency\b/i.test(text) &&
        /\bsend\b/i.test(text) &&
        (/\bconfirm/i.test(text) || /\bdo you want\b/i.test(text))
      ) {
        sentFinalConfirmation = true;
        ws.send(
          JSON.stringify({
            type: "user_message",
            text: "Yes, this is an emergency email. I confirm you should send it now.",
          })
        );
        return;
      }

      if (sawSendToolResponse && text) {
        postToolAgentResponse += `${text}\n`;
        settle();
      }
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

  return {
    conversationId,
    postToolAgentResponse: postToolAgentResponse.trim(),
    result,
  };
}

async function fetchConversationDetails(conversationId) {
  const deadline = Date.now() + 45_000;
  let last;

  while (Date.now() < deadline) {
    last = await requestJson(`${apiBase}/v1/convai/conversations/${conversationId}`);
    if (conversationHasPostSendAnswer(last)) return last;
    await wait(1_500);
  }

  return last;
}

function conversationHasPostSendAnswer(details) {
  const transcript = details?.transcript || [];
  const toolResultIndex = transcript.findIndex((turn) =>
    (turn.tool_results || []).some((result) => result.tool_name === "himalaya_email_send")
  );
  if (toolResultIndex < 0) return false;
  return transcript
    .slice(toolResultIndex + 1)
    .some((turn) => turn.role === "agent" && isRealAgentMessage(turn.message));
}

function verifyConversation(details) {
  const transcript = details.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const sendToolCall = toolCalls.find((call) => call.tool_name === "himalaya_email_send");
  const sendToolResult = transcript
    .flatMap((turn) => turn.tool_results || [])
    .find((result) => result.tool_name === "himalaya_email_send");
  const resultValue = parseMaybeJson(sendToolResult?.result_value);
  const params = parseMaybeJson(sendToolCall?.params_as_json);
  const toolResultIndex = transcript.findIndex((turn) =>
    (turn.tool_results || []).some((result) => result.tool_name === "himalaya_email_send")
  );
  const agentResponse =
    toolResultIndex >= 0
      ? transcript
          .slice(toolResultIndex + 1)
          .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
          .map((turn) => turn.message)
          .at(-1) || ""
      : "";
  const preToolAgentText = transcript
    .slice(0, Math.max(0, toolResultIndex))
    .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
    .map((turn) => turn.message)
    .join("\n");

  const checks = {
    transcript_available: transcript.length > 0,
    previewed_before_tool:
      /recipient/i.test(preToolAgentText) &&
      /subject/i.test(preToolAgentText) &&
      /emergency/i.test(preToolAgentText),
    used_email_send_tool: Boolean(sendToolCall),
    requested_expected_recipient: String(params?.to || resultValue?.to || "")
      .toLowerCase()
      .includes(sendTo.toLowerCase()),
    requested_expected_subject: String(params?.subject || resultValue?.subject || "").includes(subject),
    requested_emergency: params?.emergency === true,
    requested_previewed: params?.previewed === true,
    requested_confirmation: params?.confirmed === true,
    tool_returned_without_error: Boolean(sendToolResult) && sendToolResult.is_error === false,
    tool_sent_email: resultValue?.ok === true && resultValue?.action === "email_sent",
    agent_answered_after_tool: agentResponse.length > 0,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    agentResponse,
    toolResultSummary: {
      ok: resultValue?.ok,
      status: resultValue?.status,
      action: resultValue?.action,
      to: resultValue?.to,
      subject: resultValue?.subject,
      timeout_ms: resultValue?.timeout_ms,
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

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
