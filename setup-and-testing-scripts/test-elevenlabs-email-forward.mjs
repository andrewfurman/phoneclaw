const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;
const forwardTo = process.env.EMAIL_FORWARD_TEST_TO || "aifurman@gmail.com";
const forwardMessage =
  "Phoneclaw automated ElevenLabs validation: please ignore this forward draft.";
const question = `Please forward the most recent email in my inbox to ${forwardTo} with the message "${forwardMessage}" above the forwarded email. I confirm you should create the forward draft now, but do not send it.`;

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

const expected = await fetchMostRecentInboxEmail();
const conversation = await runConversation(question);
const details = await fetchConversationDetails(conversation.conversationId);
const verification = verifyConversation(details, expected);

console.log(
  JSON.stringify(
    {
      ok: verification.ok,
      conversation_id: conversation.conversationId,
      expected_source_id_present: Boolean(expected.id),
      expected_source_subject_length: String(expected.subject || "").length,
      conversation_status: details.status,
      agent_response_preview: verification.agentResponse.slice(0, 700),
      checks: verification.checks,
      tool_result: verification.toolResultSummary,
    },
    null,
    2
  )
);
process.exit(verification.ok ? 0 : 1);

async function fetchMostRecentInboxEmail() {
  const response = await fetch(`${workerBaseUrl}/cli/himalaya/email-list`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${toolToken}`,
    },
    body: JSON.stringify({
      folder: "INBOX",
      page_size: 1,
    }),
  });
  const body = await response.json();

  if (!response.ok || !body.ok || !body.items?.[0]?.id) {
    throw new Error(`Worker Himalaya list failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return body.items[0];
}

async function runConversation(messageText) {
  const signed = await requestJson(
    `${apiBase}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
      agentId
    )}`
  );

  const ws = new WebSocket(signed.signed_url);
  let sentQuestion = false;
  let sawForwardToolResponse = false;
  let sawEmailListResult = false;
  let sentForwardConfirmation = false;
  let toolResponseCount = 0;
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
      toolResponseCount += 1;
      if (toolName === "himalaya_email_list") {
        sawEmailListResult = true;
      }
      if (isForwardToolName(toolName) || (!toolName && toolResponseCount >= 2)) {
        sawForwardToolResponse = true;
      }
      return;
    }

    if (message.type === "agent_response") {
      const text = message.agent_response_event?.agent_response || "";
      if (
        sawEmailListResult &&
        !sentForwardConfirmation &&
        !sawForwardToolResponse &&
        /\b(confirm|confirmation)\b/i.test(text)
      ) {
        sentForwardConfirmation = true;
        ws.send(
          JSON.stringify({
            type: "user_message",
            text: "Yes, confirmed. Create the forward draft now, but do not send it.",
          })
        );
        return;
      }
      if (sawForwardToolResponse && text) {
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
    if (conversationHasPostForwardAnswer(last)) return last;
    await wait(1_500);
  }

  return last;
}

function conversationHasPostForwardAnswer(details) {
  const transcript = details?.transcript || [];
  const toolResultIndex = transcript.findIndex((turn) =>
    (turn.tool_results || []).some((result) => isForwardToolName(result.tool_name))
  );
  if (toolResultIndex < 0) return false;
  return transcript
    .slice(toolResultIndex + 1)
    .some((turn) => turn.role === "agent" && isRealAgentMessage(turn.message));
}

function verifyConversation(details, expected) {
  const transcript = details.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const listToolCall = toolCalls.find((call) => call.tool_name === "himalaya_email_list");
  const forwardToolCall = toolCalls.find((call) => isForwardToolName(call.tool_name));
  const forwardToolResult = transcript
    .flatMap((turn) => turn.tool_results || [])
    .find((result) => isForwardToolName(result.tool_name));
  const resultValue = parseMaybeJson(forwardToolResult?.result_value);
  const params = parseMaybeJson(forwardToolCall?.params_as_json);
  const toolResultIndex = transcript.findIndex((turn) =>
    (turn.tool_results || []).some((result) => isForwardToolName(result.tool_name))
  );
  const agentResponse =
    transcript
      .slice(Math.max(0, toolResultIndex + 1))
      .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
      .map((turn) => turn.message)
      .at(-1) || "";

  const checks = {
    transcript_available: transcript.length > 0,
    used_email_list_tool: Boolean(listToolCall),
    used_email_forward_tool: Boolean(forwardToolCall),
    forwarded_expected_recent_email: resultValue?.id === expected.id,
    requested_expected_recipient: String(params?.to || resultValue?.to || "")
      .toLowerCase()
      .includes(forwardTo.toLowerCase()),
    requested_confirmation: params?.confirmed === true,
    tool_returned_without_error: Boolean(forwardToolResult) && forwardToolResult.is_error === false,
    tool_created_forward_draft: resultValue?.ok === true && resultValue?.action === "forward_draft_created",
    original_html_preserved: resultValue?.original_has_html === true,
    no_original_eml_attachment: resultValue?.attached_original_eml === false,
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
      id: resultValue?.id,
      draft_id: resultValue?.draft_id,
      to: resultValue?.to,
      subject: resultValue?.subject,
      original_has_html: resultValue?.original_has_html,
      attached_original_eml: resultValue?.attached_original_eml,
    },
  };
}

function isRealAgentMessage(value) {
  const text = String(value || "").trim();
  return text.length > 5 && text !== "...";
}

function isForwardToolName(value) {
  return value === "create_forward_draft" || value === "himalaya_email_forward";
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
