const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const question =
  "Use your configured RSS tools, not memory. List the latest article from the configured Economist feed. Search configured RSS articles with the keyword America since June 1, 2026. Then get the full text for the first latest article entry id and say whether it is full text or an excerpt.";
const RSS_TOOL_NAMES = [
  "rss_recent_entries",
  "rss_search_entries",
  "rss_get_article_text",
];
const WEB_SEARCH_TOOL_NAME = "web_search";

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

const conversation = await runTextConversation(question);
const details = await fetchConversationDetails(conversation.conversationId);
const verification = verifyConversation(details);

console.log(
  JSON.stringify(
    {
      ok: verification.ok,
      conversation_id: conversation.conversationId,
      user_message: question,
      recent_count: verification.recentCount,
      search_count: verification.searchCount,
      article_entry_id: verification.articleEntryId,
      article_title: verification.articleTitle,
      article_content_source: verification.articleContentSource,
      article_full_text_chars: verification.articleFullTextChars,
      article_original_fetch_status: verification.articleOriginalFetchStatus,
      article_rss_bridge_fetch_status: verification.articleRssBridgeFetchStatus,
      full_article_available: verification.fullArticleAvailable,
      article_access_note: verification.articleAccessNote,
      agent_response_preview: verification.agentResponse.slice(0, 700),
      checks: verification.checks,
    },
    null,
    2
  )
);

process.exit(verification.ok ? 0 : 1);

async function runTextConversation(messageText) {
  const signed = await requestJson(
    `${apiBase}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
      agentId
    )}`
  );

  const ws = new WebSocket(signed.signed_url);
  let conversationId = null;
  let sentUserMessage = false;
  let toolResponseCount = 0;
  let settleTimer;
  let done;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 120_000);
  const settle = (delay = 8_000) => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => done({ reason: "settled" }), delay);
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

    if (message.type === "agent_tool_response") {
      toolResponseCount += 1;
      return;
    }

    if (message.type === "agent_response") {
      const text = message.agent_response_event?.agent_response || "";
      if (sentUserMessage && toolResponseCount >= 3 && isRealAgentMessage(text)) {
        settle();
      }
      return;
    }

    if (message.type === "agent_response_complete" && sentUserMessage) {
      settle(toolResponseCount >= 3 ? 2_000 : 12_000);
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

  return { conversationId };
}

async function fetchConversationDetails(conversationId) {
  const deadline = Date.now() + 75_000;
  let last;

  while (Date.now() < deadline) {
    last = await requestJson(`${apiBase}/v1/convai/conversations/${conversationId}`);
    if (conversationHasRssToolResults(last)) return last;
    await wait(1_500);
  }

  return last;
}

function conversationHasRssToolResults(details) {
  const transcript = details?.transcript || [];
  const toolResultNames = new Set(
    transcript.flatMap((turn) => (turn.tool_results || []).map((result) => result.tool_name))
  );
  const latestToolIndex = transcript.findLastIndex((turn) =>
    (turn.tool_results || []).some((result) => RSS_TOOL_NAMES.includes(result.tool_name))
  );

  return (
    RSS_TOOL_NAMES.every((toolName) => toolResultNames.has(toolName)) &&
    transcript
      .slice(Math.max(0, latestToolIndex + 1))
      .some((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
  );
}

function verifyConversation(details) {
  const transcript = details?.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const callsByName = new Map(toolCalls.map((call) => [call.tool_name, call]));
  const resultsByName = new Map(toolResults.map((result) => [result.tool_name, result]));
  const recentResult = parseMaybeJson(resultsByName.get("rss_recent_entries")?.result_value);
  const searchResult = parseMaybeJson(resultsByName.get("rss_search_entries")?.result_value);
  const articleResult = parseMaybeJson(resultsByName.get("rss_get_article_text")?.result_value);
  const latestToolIndex = transcript.findLastIndex((turn) =>
    (turn.tool_results || []).some((result) => RSS_TOOL_NAMES.includes(result.tool_name))
  );
  const agentResponse =
    transcript
      .slice(Math.max(0, latestToolIndex + 1))
      .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
      .map((turn) => turn.message)
      .at(-1) || "";
  const recentItems = Array.isArray(recentResult?.items) ? recentResult.items : [];
  const searchItems = Array.isArray(searchResult?.items) ? searchResult.items : [];
  const articleTextChars = Number(articleResult?.full_text_chars || 0);
  const fullArticleAvailable =
    [
      "feed_content_encoded",
      "feed_content",
      "economist_rss_bridge",
      "original_article_fetch",
      "economist_browser_fetch",
      "stored_entry_content",
    ].includes(articleResult?.content_source) &&
    articleTextChars >= 700 &&
    !articleResult?.access_note;

  const checks = {
    transcript_available: transcript.length > 0,
    used_recent_tool: callsByName.has("rss_recent_entries"),
    used_search_tool: callsByName.has("rss_search_entries"),
    used_article_text_tool: callsByName.has("rss_get_article_text"),
    did_not_use_web_search: !callsByName.has(WEB_SEARCH_TOOL_NAME),
    recent_tool_returned_without_error:
      resultsByName.has("rss_recent_entries") &&
      resultsByName.get("rss_recent_entries").is_error === false,
    search_tool_returned_without_error:
      resultsByName.has("rss_search_entries") &&
      resultsByName.get("rss_search_entries").is_error === false,
    article_text_tool_returned_without_error:
      resultsByName.has("rss_get_article_text") &&
      resultsByName.get("rss_get_article_text").is_error === false,
    recent_returned_items: recentItems.length > 0,
    search_returned_items: searchItems.length > 0,
    article_text_returned_controlled_result:
      articleResult?.ok === true && articleTextChars > 0 && Boolean(articleResult?.entry_id),
    full_article_available: fullArticleAvailable,
    agent_answered_after_tools: agentResponse.length > 0,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    recentCount: recentItems.length,
    searchCount: searchItems.length,
    articleEntryId: articleResult?.entry_id || null,
    articleTitle: articleResult?.entry?.title || "",
    articleContentSource: articleResult?.content_source || "",
    articleFullTextChars: articleTextChars,
    articleOriginalFetchStatus: articleResult?.original_fetch_status || "",
    articleRssBridgeFetchStatus: articleResult?.rss_bridge_fetch_status || "",
    fullArticleAvailable,
    articleAccessNote: articleResult?.access_note || "",
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
