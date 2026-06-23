const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;
const forwardTo = process.env.EMAIL_DRAFT_TEST_TO || "aifurman@gmail.com";

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

const selected = await fetchRecentNewsletterLikeEmail();
const forwardMessage =
  "Phoneclaw automated ElevenLabs validation forward draft. Please ignore; this was not sent.";
const replyAllMessage =
  "Phoneclaw automated ElevenLabs validation reply-all draft only. Please do not send this draft.";
const question = [
  `Please create two Gmail draft validations for the INBOX email with envelope id ${selected.id}, subject "${selected.subject}".`,
  `First create a forward draft to ${forwardTo} with this message above the original email: "${forwardMessage}"`,
  `Second create a reply-all draft with this message above the quoted original thread: "${replyAllMessage}"`,
  "I confirm both draft creations now. Do not send any email.",
].join(" ");

const conversation = await runConversation(question);
const details = await fetchConversationDetails(conversation.conversationId);
const verification = verifyConversation(details, selected);

console.log(
  JSON.stringify(
    {
      ok: verification.ok,
      conversation_id: conversation.conversationId,
      selected_email: {
        id: selected.id,
        subject: selected.subject || "",
        from: selected.from || "",
      },
      conversation_status: details.status,
      checks: verification.checks,
      forward_result: verification.forwardResultSummary,
      reply_all_result: verification.replyAllResultSummary,
      agent_response_preview: verification.agentResponse.slice(0, 700),
    },
    null,
    2
  )
);

process.exit(verification.ok ? 0 : 1);

async function fetchRecentNewsletterLikeEmail() {
  const response = await fetch(`${workerBaseUrl}/cli/himalaya/email-list`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${toolToken}`,
    },
    body: JSON.stringify({
      folder: "INBOX",
      page_size: 20,
    }),
  });
  const body = await response.json();

  if (!response.ok || !body.ok || !Array.isArray(body.items) || body.items.length === 0) {
    throw new Error(`Worker Himalaya list failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return (
    body.items.find((item) =>
      /\b(newsletter|digest|brief|daily|weekly|roundup|update|news|morning|substack|economist|axios|semafor|stratechery)\b/i.test(
        `${item.from || ""} ${item.subject || ""}`
      )
    ) || body.items[0]
  );
}

async function runConversation(messageText) {
  const signed = await requestJson(
    `${apiBase}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
      agentId
    )}`
  );

  const ws = new WebSocket(signed.signed_url);
  let sentQuestion = false;
  let sentConfirmation = false;
  let sawForwardToolResponse = false;
  let sawReplyAllToolResponse = false;
  let conversationId = null;
  let postToolAgentResponse = "";
  let done;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  let settleTimer;
  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 120_000);
  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => done({ reason: "settled" }), 7_000);
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
      if (toolName === "create_forward_draft") sawForwardToolResponse = true;
      if (toolName === "create_reply_all_draft") sawReplyAllToolResponse = true;
      if (sawForwardToolResponse && sawReplyAllToolResponse) settle();
      return;
    }

    if (message.type === "agent_response") {
      const text = message.agent_response_event?.agent_response || "";
      if (
        !sentConfirmation &&
        /\b(confirm|confirmation|do you want me to|should i)\b/i.test(text)
      ) {
        sentConfirmation = true;
        ws.send(
          JSON.stringify({
            type: "user_message",
            text: "Yes, confirmed. Create both drafts now, but do not send anything.",
          })
        );
        return;
      }

      if ((sawForwardToolResponse || sawReplyAllToolResponse) && text) {
        postToolAgentResponse += `${text}\n`;
        if (sawForwardToolResponse && sawReplyAllToolResponse) settle();
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
    if (conversationHasBothDraftResults(last)) return last;
    await wait(1_500);
  }

  return last;
}

function conversationHasBothDraftResults(details) {
  const toolNames = new Set(
    (details?.transcript || [])
      .flatMap((turn) => turn.tool_results || [])
      .map((result) => result.tool_name)
  );
  return toolNames.has("create_forward_draft") && toolNames.has("create_reply_all_draft");
}

function verifyConversation(details, selected) {
  const transcript = details.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const forwardToolCall = toolCalls.find((call) => call.tool_name === "create_forward_draft");
  const replyAllToolCall = toolCalls.find((call) => call.tool_name === "create_reply_all_draft");
  const forwardToolResult = toolResults.find((result) => result.tool_name === "create_forward_draft");
  const replyAllToolResult = toolResults.find(
    (result) => result.tool_name === "create_reply_all_draft"
  );
  const forwardResultValue = parseMaybeJson(forwardToolResult?.result_value);
  const replyAllResultValue = parseMaybeJson(replyAllToolResult?.result_value);
  const forwardParams = parseMaybeJson(forwardToolCall?.params_as_json);
  const replyAllParams = parseMaybeJson(replyAllToolCall?.params_as_json);
  const lastToolResultIndex = Math.max(
    transcript.findIndex((turn) =>
      (turn.tool_results || []).some((result) => result.tool_name === "create_forward_draft")
    ),
    transcript.findIndex((turn) =>
      (turn.tool_results || []).some((result) => result.tool_name === "create_reply_all_draft")
    )
  );
  const agentResponse =
    transcript
      .slice(Math.max(0, lastToolResultIndex + 1))
      .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
      .map((turn) => turn.message)
      .at(-1) || "";

  const checks = {
    transcript_available: transcript.length > 0,
    used_create_forward_draft: Boolean(forwardToolCall),
    used_create_reply_all_draft: Boolean(replyAllToolCall),
    forward_used_expected_email: forwardResultValue?.id === selected.id,
    reply_all_used_expected_email: replyAllResultValue?.id === selected.id,
    forward_requested_expected_recipient: String(
      forwardParams?.to || forwardResultValue?.to || ""
    )
      .toLowerCase()
      .includes(forwardTo.toLowerCase()),
    forward_tool_created_draft:
      forwardResultValue?.ok === true &&
      forwardResultValue?.action === "forward_draft_created",
    reply_all_tool_created_draft:
      replyAllResultValue?.ok === true &&
      replyAllResultValue?.action === "reply_all_draft_created",
    forward_preserved_inline_original:
      forwardResultValue?.attached_original_eml === false &&
      (forwardResultValue?.original_has_html === true ||
        forwardResultValue?.original_has_plain === true),
    reply_all_preserved_inline_original:
      replyAllResultValue?.attached_original_eml === false &&
      (replyAllResultValue?.original_has_html === true ||
        replyAllResultValue?.original_has_plain === true),
    both_confirmed: forwardParams?.confirmed === true && replyAllParams?.confirmed === true,
    agent_answered_after_tools: agentResponse.length > 0,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    agentResponse,
    forwardResultSummary: summarizeToolResult(forwardResultValue),
    replyAllResultSummary: summarizeToolResult(replyAllResultValue),
  };
}

function summarizeToolResult(value) {
  return {
    ok: value?.ok,
    status: value?.status,
    action: value?.action,
    id: value?.id,
    draft_id: value?.draft_id,
    to: value?.to,
    subject: value?.subject,
    reply_all: value?.reply_all,
    original_has_html: value?.original_has_html,
    original_has_plain: value?.original_has_plain,
    attached_original_eml: value?.attached_original_eml,
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
  const body = parseMaybeJson(text);

  if (!response.ok) {
    throw new Error(`ElevenLabs request failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return body;
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
