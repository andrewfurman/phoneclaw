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

const testCases = [
  {
    itemType: "issues",
    question:
      "How many open GitHub issues do I have, and what are the top ones about? Please answer from GitHub.",
  },
  {
    itemType: "pull_requests",
    question:
      "How many open GitHub pull requests do I have, and what are the top ones about? Please answer from GitHub.",
  },
];

const results = [];
for (const testCase of testCases) {
  const expected = await fetchWorkerGithubSummary(testCase.itemType);
  const conversation = await runConversation(testCase.question);
  const details = await fetchConversationDetails(conversation.conversationId);
  const verification = verifyConversation(details, testCase.itemType, expected);

  results.push({
    item_type: testCase.itemType,
    ok: verification.ok,
    conversation_id: conversation.conversationId,
    expected_total_count: expected.total_count,
    tool_total_count: verification.toolTotalCount,
    conversation_status: verification.conversationStatus,
    agent_response_preview: verification.agentResponse.slice(0, 700),
    checks: verification.checks,
  });
}

const ok = results.every((result) => result.ok);
console.log(JSON.stringify({ ok, results }, null, 2));
process.exit(ok ? 0 : 1);

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

async function runConversation(question) {
  const signed = await requestJson(
    `${apiBase}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
      agentId
    )}`
  );

  const ws = new WebSocket(signed.signed_url);
  let sentQuestion = false;
  let sawToolResponse = false;
  let conversationId = null;
  let postToolAgentResponse = "";
  let done;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  let settleTimer;
  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 60_000);
  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => done({ reason: "settled" }), 4_500);
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
        ws.send(JSON.stringify({ type: "user_message", text: question }));
      }
      return;
    }

    if (!sentQuestion) return;

    if (message.type === "agent_tool_response") {
      sawToolResponse = true;
      return;
    }

    if (message.type === "agent_response") {
      const text = message.agent_response_event?.agent_response || "";
      if (sawToolResponse && text) {
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
    sawToolResponse,
    postToolAgentResponse: postToolAgentResponse.trim(),
    result,
  };
}

async function fetchConversationDetails(conversationId) {
  const deadline = Date.now() + 45_000;
  let last;

  while (Date.now() < deadline) {
    last = await requestJson(`${apiBase}/v1/convai/conversations/${conversationId}`);
    if (conversationHasPostToolAnswer(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
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

function verifyConversation(details, itemType, expected) {
  const transcript = details.transcript || [];
  const toolCall = transcript
    .flatMap((turn) => turn.tool_calls || [])
    .find((call) => call.tool_name === "github_summary");
  const toolResult = transcript
    .flatMap((turn) => turn.tool_results || [])
    .find((result) => result.tool_name === "github_summary");
  const toolResultIndex = transcript.findIndex((turn) =>
    (turn.tool_results || []).some((result) => result.tool_name === "github_summary")
  );
  const agentResponse = transcript
    .slice(Math.max(0, toolResultIndex + 1))
    .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
    .map((turn) => turn.message)
    .at(-1) || "";
  const resultValue = parseMaybeJson(toolResult?.result_value);
  const params = parseMaybeJson(toolCall?.params_as_json);
  const returnedItems = Array.isArray(resultValue?.items) ? resultValue.items : [];
  const hasReturnedItems = returnedItems.length > 0;

  const checks = {
    transcript_available: transcript.length > 0,
    used_github_summary_tool: Boolean(toolCall),
    tool_returned_without_error: Boolean(toolResult) && toolResult.is_error === false,
    requested_expected_item_type: params?.item_type === itemType,
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
    conversationStatus: details.status,
    toolTotalCount: resultValue?.total_count,
    agentResponse,
  };
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
