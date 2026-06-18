const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const testRepo = process.env.GITHUB_FILES_TEST_REPO || "andrewfurman/phoneclaw";
const testFile = process.env.GITHUB_FILES_TEST_FILE || "README.md";
const testPath = process.env.GITHUB_FILES_TEST_PATH || "";

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

const question = [
  `Use the GitHub tools to list the ${testPath || "root"} folder of ${testRepo}.`,
  `Then read ${testFile} from ${testRepo}.`,
  "Answer briefly and mention whether both GitHub tool calls worked.",
].join(" ");

const conversation = await runConversation(question);
const details = await fetchConversationDetails(conversation.conversationId);
const verification = verifyConversation(details);

console.log(
  JSON.stringify(
    {
      ok: verification.ok,
      conversation_id: conversation.conversationId,
      repo: testRepo,
      file: testFile,
      conversation_status: details.status,
      agent_response_preview: verification.agentResponse.slice(0, 700),
      checks: verification.checks,
      tool_results: verification.toolResults,
    },
    null,
    2
  )
);

process.exit(verification.ok ? 0 : 1);

async function runConversation(text) {
  const signed = await requestJson(
    `${apiBase}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
      agentId
    )}`
  );

  const ws = new WebSocket(signed.signed_url);
  let sentQuestion = false;
  let conversationId = null;
  let toolResponseCount = 0;
  let postToolAgentResponse = "";
  let done;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  let settleTimer;
  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 75_000);
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
        ws.send(JSON.stringify({ type: "user_message", text }));
      }
      return;
    }

    if (!sentQuestion) return;

    if (message.type === "agent_tool_response") {
      toolResponseCount += 1;
      return;
    }

    if (message.type === "agent_response") {
      const responseText = message.agent_response_event?.agent_response || "";
      if (toolResponseCount >= 2 && responseText) {
        postToolAgentResponse += `${responseText}\n`;
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
    if (conversationHasFileToolAnswers(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  return last;
}

function conversationHasFileToolAnswers(details) {
  const transcript = details?.transcript || [];
  const toolNames = new Set(
    transcript.flatMap((turn) =>
      (turn.tool_results || []).map((result) => result.tool_name)
    )
  );
  if (!toolNames.has("github_cli_ls") || !toolNames.has("github_cli_cat")) {
    return false;
  }

  const finalToolIndex = transcript.findLastIndex((turn) =>
    (turn.tool_results || []).some((result) =>
      ["github_cli_ls", "github_cli_cat"].includes(result.tool_name)
    )
  );
  return transcript
    .slice(finalToolIndex + 1)
    .some((turn) => turn.role === "agent" && isRealAgentMessage(turn.message));
}

function verifyConversation(details) {
  const transcript = details.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const lsCall = toolCalls.find((call) => call.tool_name === "github_cli_ls");
  const catCall = toolCalls.find((call) => call.tool_name === "github_cli_cat");
  const lsResult = toolResults.find((result) => result.tool_name === "github_cli_ls");
  const catResult = toolResults.find((result) => result.tool_name === "github_cli_cat");
  const lsValue = parseMaybeJson(lsResult?.result_value);
  const catValue = parseMaybeJson(catResult?.result_value);
  const lsParams = parseMaybeJson(lsCall?.params_as_json);
  const catParams = parseMaybeJson(catCall?.params_as_json);
  const finalToolIndex = transcript.findLastIndex((turn) =>
    (turn.tool_results || []).some((result) =>
      ["github_cli_ls", "github_cli_cat"].includes(result.tool_name)
    )
  );
  const agentResponse =
    transcript
      .slice(Math.max(0, finalToolIndex + 1))
      .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
      .map((turn) => turn.message)
      .at(-1) || "";

  const checks = {
    transcript_available: transcript.length > 0,
    used_github_cli_ls_tool: Boolean(lsCall),
    used_github_cli_cat_tool: Boolean(catCall),
    ls_returned_without_error: Boolean(lsResult) && lsResult.is_error === false,
    cat_returned_without_error: Boolean(catResult) && catResult.is_error === false,
    ls_repo_matches: lsParams?.repo === testRepo,
    cat_repo_matches: catParams?.repo === testRepo,
    cat_path_matches: catParams?.path === testFile,
    ls_payload_ok: lsValue?.ok === true && Array.isArray(lsValue.entries),
    cat_payload_ok:
      catValue?.ok === true && typeof catValue.content === "string" && catValue.content.length > 0,
    agent_answered_after_tools: agentResponse.length > 0,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    agentResponse,
    toolResults: {
      ls: {
        repo: lsValue?.repo,
        path: lsValue?.path,
        total_count: lsValue?.total_count,
        returned_count: lsValue?.returned_count,
      },
      cat: {
        repo: catValue?.repo,
        path: catValue?.path,
        size_bytes: catValue?.size_bytes,
        returned_bytes: catValue?.returned_bytes,
        truncated: catValue?.truncated,
      },
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
