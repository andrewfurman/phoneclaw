const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;
const WEB_SEARCH_TOOL_NAME = "web_search";
const question =
  "I am going to see Curacao versus Ivory Coast. I do not know either team. Use your web_search tool efficiently, with at most two searches, and tell me the most famous players to watch, their notable clubs, and anything interesting about the coaches.";

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

const wiring = await verifyWebSearchWiring();
const conversation = await runConversation(question);
const details = await fetchConversationDetails(conversation.conversationId);
const verification = verifyConversation(details);

console.log(
  JSON.stringify(
    {
      ok: verification.ok,
      conversation_id: conversation.conversationId,
      conversation_status: details?.status || null,
      user_message: question,
      wiring,
      web_search_call_count: verification.webSearchCalls.length,
      web_search_results: verification.webSearchResults,
      agent_search_status_message_count: verification.agentSearchStatusMessageCount,
      agent_response_preview: verification.agentResponse.slice(0, 900),
      checks: verification.checks,
    },
    null,
    2
  )
);

process.exit(verification.ok ? 0 : 1);

async function verifyWebSearchWiring() {
  const agent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`);
  const tools = agent.conversation_config?.agent?.prompt?.tools || [];
  const webSearchTool = tools.find((tool) => tool.name === WEB_SEARCH_TOOL_NAME);
  const expectedUrl = `${workerBaseUrl}/web-search`;
  const actualUrl = webSearchTool?.api_schema?.url || "";
  const responseProperties =
    webSearchTool?.api_schema?.response_body_schema?.properties || {};

  if (actualUrl !== expectedUrl) {
    throw new Error(
      `ElevenLabs web_search tool URL mismatch. Expected ${expectedUrl}, got ${actualUrl || "(missing)"}.`
    );
  }

  if (!responseProperties.diagnostics || !responseProperties.result_count) {
    throw new Error(
      "ElevenLabs web_search tool schema is missing diagnostics or result_count."
    );
  }

  const response = await fetch(expectedUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${toolToken}`,
    },
    body: JSON.stringify({
      query: "Ivory Coast Curacao national football key players coaches",
      max_results: 5,
    }),
  });
  const body = await response.json().catch(async () => ({
    raw: await response.text(),
  }));

  if (!response.ok || body.ok !== true || Number(body.result_count || 0) <= 0) {
    throw new Error(
      `Direct Worker web_search preflight failed (${response.status}): ${JSON.stringify(body)}`
    );
  }

  if (!String(body.provider || "").toLowerCase().includes("tavily")) {
    throw new Error(
      `Direct Worker web_search did not use Tavily: ${JSON.stringify({
        provider: body.provider,
        source_note: body.source_note,
        diagnostics: body.diagnostics,
      })}`
    );
  }

  return {
    url: actualUrl,
    force_pre_tool_speech: webSearchTool?.force_pre_tool_speech ?? null,
    direct_worker_provider: body.provider,
    direct_worker_result_count: body.result_count,
    direct_worker_has_diagnostics: Array.isArray(body.diagnostics),
  };
}

async function runConversation(messageText) {
  const signed = await requestJson(
    `${apiBase}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
      agentId
    )}`
  );

  const ws = new WebSocket(signed.signed_url);
  let conversationId = null;
  let sentUserMessage = false;
  let toolResponseCount = 0;
  let sawAgentAnswerAfterSearch = false;
  let done;
  let settleTimer;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 90_000);
  const settle = (delay = 5_000) => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => done({ reason: "settled" }), delay);
  };
  const clearSettle = () => {
    clearTimeout(settleTimer);
    settleTimer = null;
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
      if (!sentUserMessage) {
        sentUserMessage = true;
        ws.send(JSON.stringify({ type: "user_message", text: messageText }));
      }
      return;
    }

    if (!sentUserMessage) return;

    if (message.type === "agent_tool_call") {
      clearSettle();
      return;
    }

    if (message.type === "agent_tool_response") {
      clearSettle();
      toolResponseCount += 1;
      return;
    }

    if (message.type === "agent_response") {
      const text = message.agent_response_event?.agent_response || "";
      if (toolResponseCount > 0 && isRealAgentMessage(text)) {
        sawAgentAnswerAfterSearch =
          sawAgentAnswerAfterSearch || !isLikelySearchStatusMessage(text);
        settle(sawAgentAnswerAfterSearch ? 8_000 : 20_000);
      }
      return;
    }

    if (message.type === "agent_response_complete") {
      settle(sawAgentAnswerAfterSearch ? 8_000 : toolResponseCount > 0 ? 20_000 : 12_000);
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
    if (conversationHasSearchAndAnswer(last)) return last;
    await wait(1_500);
  }

  return last;
}

function conversationHasSearchAndAnswer(details) {
  const transcript = details?.transcript || [];
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const webResults = toolResults.filter((result) => result.tool_name === WEB_SEARCH_TOOL_NAME);
  const latestToolIndex = transcript.findLastIndex((turn) =>
    (turn.tool_results || []).some((result) => result.tool_name === WEB_SEARCH_TOOL_NAME)
  );

  return (
    webResults.length > 0 &&
    transcript
      .slice(Math.max(0, latestToolIndex + 1))
      .some((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
  );
}

function verifyConversation(details) {
  const transcript = details?.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const webSearchCalls = toolCalls.filter((call) => call.tool_name === WEB_SEARCH_TOOL_NAME);
  const webSearchResults = toolResults
    .filter((result) => result.tool_name === WEB_SEARCH_TOOL_NAME)
    .map((result, index) => {
      const value = parseMaybeJson(result.result_value);
      const params = parseMaybeJson(webSearchCalls[index]?.params_as_json);
      return {
        query: value?.query || params?.query || "",
        provider: value?.provider || "",
        result_count: Number(value?.result_count || 0),
        ok: value?.ok === true && result.is_error === false,
        diagnostics: value?.diagnostics || [],
      };
    });
  const latestToolIndex = transcript.findLastIndex((turn) =>
    (turn.tool_results || []).some((result) => result.tool_name === WEB_SEARCH_TOOL_NAME)
  );
  const agentMessages = transcript
    .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
    .map((turn) => turn.message);
  const agentResponse =
    transcript
      .slice(Math.max(0, latestToolIndex + 1))
      .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
      .map((turn) => turn.message)
      .at(-1) || "";
  const agentSearchStatusMessageCount = agentMessages.filter((message) =>
    isLikelySearchStatusMessage(message)
  ).length;

  const checks = {
    transcript_available: transcript.length > 0,
    used_web_search: webSearchCalls.length > 0,
    kept_web_search_to_two_or_fewer: webSearchCalls.length <= 2,
    returned_web_search_results: webSearchResults.length > 0,
    all_web_search_results_succeeded:
      webSearchResults.length > 0 && webSearchResults.every((result) => result.ok),
    all_web_search_results_have_positive_count:
      webSearchResults.length > 0 &&
      webSearchResults.every((result) => result.result_count > 0),
    all_web_search_results_used_tavily:
      webSearchResults.length > 0 &&
      webSearchResults.every((result) =>
        String(result.provider || "").toLowerCase().includes("tavily")
      ),
    no_repeated_search_status_speech: agentSearchStatusMessageCount <= 1,
    agent_answered_after_tools: agentResponse.length > 0,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    webSearchCalls,
    webSearchResults,
    agentSearchStatusMessageCount,
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

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRealAgentMessage(value) {
  const text = String(value || "").trim();
  return text.length > 5 && text !== "...";
}

function isLikelySearchStatusMessage(value) {
  const text = String(value || "").trim();
  return (
    text.length > 0 &&
    text.length < 180 &&
    /^(i('|’)ll|i will|i am|i'm|let me|checking|searching|looking up|i will look|i will search)\b/i.test(
      text
    ) &&
    /\b(search|searching|look(?:ing)? up|checking)\b/i.test(text)
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
