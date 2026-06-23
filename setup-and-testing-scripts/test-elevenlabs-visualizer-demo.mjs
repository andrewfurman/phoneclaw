const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const testStamp = new Date().toISOString().replace(/[:.]/g, "-");
const issueTitle = `Phoneclaw visualizer validation ${testStamp}`;
const draftSubject = `Phoneclaw visualizer validation ${testStamp}`;
const recipient = process.env.VISUALIZER_DEMO_EMAIL_TO || "aifurman@gmail.com";
const issueRepo = process.env.VISUALIZER_DEMO_REPO || "andrewfurman/phoneclaw";
const question = [
  "This is an automated Phoneclaw visualizer validation call.",
  "Please do all of the following so the live visualizer has real artifacts to show:",
  "1. Use your configured RSS tools to get the latest article from the configured Economist feed and get the article text for the first entry.",
  `2. Create a Gmail draft to ${recipient} with subject "${draftSubject}" and body "Phoneclaw visualizer validation draft. Please ignore." Do not send it.`,
  `3. Create a GitHub issue in ${issueRepo} with title "${issueTitle}" and body "Automated validation issue for the live conversation visualizer. This can be closed after validation."`,
  "I explicitly confirm the exact Gmail draft recipient, subject, and body.",
  "I explicitly confirm the exact GitHub repo, issue title, and issue body.",
  "Please perform the confirmed draft save and issue creation, then summarize the links briefly.",
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
      issue_title: issueTitle,
      draft_subject: draftSubject,
      github_issue_url: verification.githubIssueUrl,
      gmail_draft_subject: verification.gmailDraftSubject,
      economist_article_url: verification.economistArticleUrl,
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
  let sentConfirmation = false;
  let conversationId = null;
  let postToolAgentResponse = "";
  const seenToolResponses = new Set();
  let done;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  let settleTimer;
  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 180_000);
  const settle = (delay = 8_000) => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => done({ reason: "settled" }), delay);
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
      if (toolName) seenToolResponses.add(toolName);
      if (hasCoreToolResponses(seenToolResponses)) settle();
      return;
    }

    if (message.type === "agent_response") {
      const text = message.agent_response_event?.agent_response || "";
      if (!sentConfirmation && /\bconfirm/i.test(text)) {
        sentConfirmation = true;
        ws.send(
          JSON.stringify({
            type: "user_message",
            text:
              "Yes, confirmed. Create the Gmail draft exactly as stated, do not send it, and create the GitHub issue exactly as stated.",
          })
        );
        return;
      }

      if (hasCoreToolResponses(seenToolResponses) && isRealAgentMessage(text)) {
        postToolAgentResponse += `${text}\n`;
        settle(4_000);
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
  const deadline = Date.now() + 90_000;
  let last;

  while (Date.now() < deadline) {
    last = await requestJson(`${apiBase}/v1/convai/conversations/${conversationId}`);
    const verification = verifyConversation(last);
    if (verification.checks.agent_answered_after_tools && verification.checks.transcript_available) {
      return last;
    }
    await wait(1_500);
  }

  return last;
}

function verifyConversation(details) {
  const transcript = details?.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const resultValues = toolResults.map((result) => ({
    tool_name: result.tool_name,
    is_error: result.is_error,
    value: parseMaybeJson(result.result_value),
  }));
  const latestToolIndex = transcript.findLastIndex((turn) => (turn.tool_results || []).length > 0);
  const agentResponse =
    transcript
      .slice(Math.max(0, latestToolIndex + 1))
      .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
      .map((turn) => turn.message)
      .at(-1) || "";
  const githubIssue = resultValues
    .map((item) => item.value?.issue)
    .find((issue) => issue?.url && issue?.title === issueTitle);
  const draftResult = resultValues.find((item) =>
    ["draft_created", "reply_draft_created", "forward_draft_created"].includes(item.value?.action)
  );
  const economistArticle =
    resultValues
      .flatMap((item) => [
        item.value?.entry,
        ...(Array.isArray(item.value?.items) ? item.value.items : []),
      ])
      .find((entry) => /^https:\/\/(www\.)?economist\.com\//i.test(entry?.url || "")) || null;

  const checks = {
    transcript_available: transcript.length > 0,
    used_rss_tool: toolCalls.some((call) => call.tool_name?.startsWith("rss_")),
    used_github_issue_create: toolCalls.some((call) => call.tool_name === "github_issue_create"),
    used_himalaya_draft_create: toolCalls.some((call) => call.tool_name === "himalaya_draft_create"),
    rss_result_without_error: toolResults.some(
      (result) => result.tool_name?.startsWith("rss_") && result.is_error === false
    ),
    github_issue_created:
      Boolean(githubIssue?.url) &&
      toolResults.some((result) => result.tool_name === "github_issue_create" && result.is_error === false),
    gmail_draft_created:
      draftResult?.tool_name === "himalaya_draft_create" &&
      draftResult?.is_error === false &&
      draftResult?.value?.action === "draft_created",
    economist_article_link_found: Boolean(economistArticle?.url),
    agent_answered_after_tools: agentResponse.length > 0,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    githubIssueUrl: githubIssue?.url || "",
    gmailDraftSubject: draftResult?.value?.subject || "",
    economistArticleUrl: economistArticle?.url || "",
    agentResponse,
  };
}

function hasCoreToolResponses(seenToolResponses) {
  return (
    [...seenToolResponses].some((name) => name.startsWith("rss_")) &&
    seenToolResponses.has("himalaya_draft_create") &&
    seenToolResponses.has("github_issue_create")
  );
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
