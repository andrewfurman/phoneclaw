import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import { claudeCodeTool } from "./claude-code-tools.mjs";
import {
  archiveElevenLabsConversation,
  archiveLatestElevenLabsConversations,
  conversationHistoryConfigured,
  conversationHistoryGet,
  conversationHistorySearch,
  conversationRecentContext,
} from "./conversation-history.mjs";
import {
  githubCliCommon,
  himalayaCreateForwardDraft,
  himalayaCreateReplyAllDraft,
  himalayaDraftCreate,
  himalayaDraftReply,
  himalayaEmailArchive,
  himalayaEmailForward,
  himalayaEmailList,
  himalayaEmailRead,
  himalayaEmailSend,
  otterSpeechGet,
  otterSpeechSearch,
  otterSpeechesList,
} from "./cli-tools.mjs";
import {
  economistRssBridgeConfigured,
  minifluxConfigured,
  economistFullTextBrowserConfigured,
  rssEntryFullText,
  rssRecentEntries,
  rssRefreshFeeds,
  rssSearchEntries,
} from "./miniflux-tools.mjs";
import {
  configuredRssFeedsConfigured,
  rssConfiguredEntryFullText,
  rssConfiguredRecentEntries,
  rssConfiguredSearchEntries,
  rssListConfiguredFeeds,
  rssRefreshConfiguredFeeds,
} from "./rss-feed-tools.mjs";
import {
  githubCliCatGh,
  githubCliLsGh,
  githubIssueCreateGh,
  githubIssueUpdateGh,
  githubSummaryGh,
} from "./github-gh-tools.mjs";
import { basicWebSearch } from "../shared/basic-web-search.mjs";
import {
  isAllowedCaller,
  lastFourDigits,
  parseAllowedCallerNumbers,
} from "../shared/phone-numbers.mjs";
import { ELEVENLABS_TELEPHONY_AUDIO_FORMAT } from "../shared/telephony-audio-format.mjs";
import {
  attachStreamStatusCallback,
  buildTwilioEvent,
} from "../shared/twilio-events.mjs";

const { validateRequest } = twilio;

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "127.0.0.1";
const elevenLabsApiBase =
  process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const elevenLabsAgentId = process.env.ELEVENLABS_AGENT_ID;
const commandBridgeToken = process.env.COMMAND_BRIDGE_TOKEN;
const webSearchToken = process.env.WEB_SEARCH_TOKEN || commandBridgeToken;
const cliBridgeToken = process.env.CLI_BRIDGE_TOKEN;
const claudeBridgeUrl = process.env.CLAUDE_BRIDGE_URL;
const claudeBridgeToken = process.env.CLAUDE_BRIDGE_TOKEN;
const economistPublicRssToken = process.env.ECONOMIST_PUBLIC_RSS_TOKEN;
const economistRssBridgeBaseUrl =
  process.env.ECONOMIST_RSS_BRIDGE_BASE_URL || "http://127.0.0.1:3000/";
const economistPublicRssAllowedTopics = new Set(
  parseCsv(process.env.ECONOMIST_PUBLIC_RSS_ALLOWED_TOPICS || "latest")
);
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const enforceTwilioSignature =
  process.env.ENFORCE_TWILIO_SIGNATURE === "true" && Boolean(twilioAuthToken);
const outsideCoverageMessage =
  process.env.OUTSIDE_COVERAGE_MESSAGE ||
  "Thanks for calling Andrew's assistance line. Sorry we haven't set up outside coverage yet.";
const twilioEvents = [];

const app = Fastify({
  logger: {
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: redactUrlForLogs(request.url),
          host: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        };
      },
    },
  },
  trustProxy: true,
  bodyLimit: 1_000_000,
});

await app.register(formbody);

app.get("/", async () => ({
  ok: true,
  endpoints: {
    twilio_inbound: "POST /twilio/inbound",
    twilio_outbound: "POST /twilio/outbound",
    twilio_stream_status: "POST /twilio/stream-status",
    twilio_call_status: "POST /twilio/call-status",
    twilio_events: "GET /twilio/events",
    web_search: "POST /web-search",
    github_summary: "POST /github-summary",
    github_cli_ls: "POST /github-cli/ls",
    github_cli_cat: "POST /github-cli/cat",
    github_issue_create: "POST /github-issues/create",
    github_issue_update: "POST /github-issues/update",
    himalaya_email_list: "POST /cli/himalaya/email-list",
    himalaya_email_read: "POST /cli/himalaya/email-read",
    himalaya_email_archive: "POST /cli/himalaya/email-archive",
    himalaya_draft_create: "POST /cli/himalaya/draft-create",
    himalaya_draft_reply: "POST /cli/himalaya/draft-reply",
    himalaya_email_forward: "POST /cli/himalaya/email-forward",
    create_reply_all_draft: "POST /cli/himalaya/create-reply-all-draft",
    create_forward_draft: "POST /cli/himalaya/create-forward-draft",
    himalaya_email_send: "POST /cli/himalaya/email-send",
    otter_speeches_list: "POST /cli/otter/speeches-list",
    otter_speech_get: "POST /cli/otter/speech-get",
    otter_speech_search: "POST /cli/otter/speech-search",
    github_cli_common: "POST /cli/github/common",
    rss_recent_economist_entries: "POST /cli/rss/economist/recent",
    rss_search_economist_entries: "POST /cli/rss/economist/search",
    rss_get_economist_article_text: "POST /cli/rss/economist/article-text",
    rss_refresh_economist_feeds: "POST /cli/rss/economist/refresh",
    rss_list_feeds: "POST /cli/rss/feeds",
    rss_recent_entries: "POST /cli/rss/recent",
    rss_search_entries: "POST /cli/rss/search",
    rss_get_article_text: "POST /cli/rss/article-text",
    rss_refresh_feeds: "POST /cli/rss/refresh",
    claude_code: "POST /cli/claude-code",
    conversation_history_search: "POST /conversation-history/search",
    conversation_history_get: "POST /conversation-history/get",
    conversation_history_recent_context: "POST /conversation-history/recent-context",
    conversation_history_archive: "POST /conversation-history/archive-elevenlabs",
    future_claude_tool: "POST /agent-command",
    health: "GET /health",
  },
}));

app.get("/health", async () => ({
  ok: true,
  elevenlabs_agent_configured: Boolean(elevenLabsAgentId),
  command_bridge_configured: Boolean(claudeBridgeUrl),
  web_search_configured: Boolean(webSearchToken),
  cli_bridge_token_configured: Boolean(cliBridgeToken),
  github_cli_bridge_configured: Boolean(cliBridgeToken || webSearchToken),
  claude_code_bridge_configured: true,
  miniflux_configured: minifluxConfigured(),
  economist_rss_bridge_configured: economistRssBridgeConfigured(),
  economist_public_rss_configured: Boolean(economistPublicRssToken),
  economist_browser_fetch_configured: economistFullTextBrowserConfigured(),
  configured_rss_feeds_configured: configuredRssFeedsConfigured(),
  conversation_history_configured: conversationHistoryConfigured(),
  expected_elevenlabs_audio_format: ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
  allowed_caller_numbers_configured:
    parseAllowedCallerNumbers(process.env.ALLOWED_CALLER_NUMBERS).length > 0,
  twilio_signature_enforced: enforceTwilioSignature,
  twilio_event_log_configured: true,
}));

app.get("/rss/economist/:topic.atom", async (request, reply) =>
  handleEconomistPublicRss(request, reply)
);

app.post("/twilio/inbound", async (request, reply) =>
  handleTwilioCall(request, reply, "inbound")
);

app.post("/twilio/outbound", async (request, reply) =>
  handleTwilioCall(request, reply, "outbound")
);

app.post("/twilio/stream-status", async (request, reply) =>
  handleTwilioStatusCallback(request, reply, "twilio_stream_status")
);

app.post("/twilio/call-status", async (request, reply) =>
  handleTwilioStatusCallback(request, reply, "twilio_call_status")
);

app.get("/twilio/events", async (request, reply) => handleTwilioEvents(request, reply));

app.post("/agent-command", async (request, reply) => handleAgentCommand(request, reply));

app.post("/web-search", async (request, reply) => handleWebSearch(request, reply));

app.post("/github-summary", async (request, reply) =>
  handleGithubSummary(request, reply)
);

app.post("/github-cli/ls", async (request, reply) => handleGithubCliLs(request, reply));

app.post("/github-cli/cat", async (request, reply) =>
  handleGithubCliCat(request, reply)
);

app.post("/github-issues/create", async (request, reply) =>
  handleGithubIssueCreate(request, reply)
);

app.post("/github-issues/update", async (request, reply) =>
  handleGithubIssueUpdate(request, reply)
);

app.post("/cli/himalaya/email-list", async (request, reply) =>
  handleHimalayaEmailList(request, reply)
);

app.post("/cli/himalaya/email-read", async (request, reply) =>
  handleHimalayaEmailRead(request, reply)
);

app.post("/cli/himalaya/email-archive", async (request, reply) =>
  handleHimalayaEmailArchive(request, reply)
);

app.post("/cli/himalaya/draft-create", async (request, reply) =>
  handleHimalayaDraftCreate(request, reply)
);

app.post("/cli/himalaya/draft-reply", async (request, reply) =>
  handleHimalayaDraftReply(request, reply)
);

app.post("/cli/himalaya/email-forward", async (request, reply) =>
  handleHimalayaEmailForward(request, reply)
);

app.post("/cli/himalaya/create-reply-all-draft", async (request, reply) =>
  handleCreateReplyAllDraft(request, reply)
);

app.post("/cli/himalaya/create-forward-draft", async (request, reply) =>
  handleCreateForwardDraft(request, reply)
);

app.post("/cli/himalaya/email-send", async (request, reply) =>
  handleHimalayaEmailSend(request, reply)
);

app.post("/cli/otter/speeches-list", async (request, reply) =>
  handleOtterSpeechesList(request, reply)
);

app.post("/cli/otter/speech-get", async (request, reply) =>
  handleOtterSpeechGet(request, reply)
);

app.post("/cli/otter/speech-search", async (request, reply) =>
  handleOtterSpeechSearch(request, reply)
);

app.post("/cli/github/common", async (request, reply) =>
  handleGithubCliCommon(request, reply)
);

app.post("/cli/rss/economist/recent", async (request, reply) =>
  handleRssRecentEconomistEntries(request, reply)
);

app.post("/cli/rss/economist/search", async (request, reply) =>
  handleRssSearchEconomistEntries(request, reply)
);

app.post("/cli/rss/economist/article-text", async (request, reply) =>
  handleRssGetEconomistArticleText(request, reply)
);

app.post("/cli/rss/economist/refresh", async (request, reply) =>
  handleRssRefreshEconomistFeeds(request, reply)
);

app.post("/cli/rss/feeds", async (request, reply) => handleRssListFeeds(request, reply));

app.post("/cli/rss/recent", async (request, reply) =>
  handleRssRecentEntries(request, reply)
);

app.post("/cli/rss/search", async (request, reply) =>
  handleRssSearchEntries(request, reply)
);

app.post("/cli/rss/article-text", async (request, reply) =>
  handleRssGetArticleText(request, reply)
);

app.post("/cli/rss/refresh", async (request, reply) =>
  handleRssRefreshFeeds(request, reply)
);

app.post("/cli/claude-code", async (request, reply) =>
  handleClaudeCodeTool(request, reply)
);

app.post("/conversation-history/search", async (request, reply) =>
  handleConversationHistorySearch(request, reply)
);

app.post("/conversation-history/get", async (request, reply) =>
  handleConversationHistoryGet(request, reply)
);

app.post("/conversation-history/recent-context", async (request, reply) =>
  handleConversationRecentContext(request, reply)
);

app.post("/conversation-history/archive-elevenlabs", async (request, reply) =>
  handleConversationArchiveElevenLabs(request, reply)
);

async function handleEconomistPublicRss(request, reply) {
  if (!isValidEconomistPublicRssRequest(request)) {
    return reply.code(404).send({ ok: false, status: "not_found" });
  }

  const topic = String(request.params?.topic || "").toLowerCase();
  if (!economistPublicRssAllowedTopics.has(topic)) {
    return reply.code(404).send({ ok: false, status: "not_found" });
  }

  const upstreamUrl = new URL(economistRssBridgeBaseUrl);
  upstreamUrl.searchParams.set("action", "display");
  if (topic === "world-in-brief") {
    upstreamUrl.searchParams.set("bridge", "EconomistWorldInBrief");
    upstreamUrl.searchParams.set("mergeEverything", "1");
    upstreamUrl.searchParams.set("agenda", "1");
    upstreamUrl.searchParams.set("quote", "1");
  } else {
    upstreamUrl.searchParams.set("bridge", "Economist");
    upstreamUrl.searchParams.set("context", "Topics");
    upstreamUrl.searchParams.set(
      "topic",
      topic === "latest" ? process.env.ECONOMIST_RSS_BRIDGE_LATEST_CONTEXT || "latest" : topic
    );
  }
  const maxEntries = clampInteger(process.env.ECONOMIST_PUBLIC_RSS_MAX_ENTRIES, 1, 20, 10);
  const requestedLimit = clampInteger(request.query?.limit, 1, maxEntries, maxEntries);
  if (topic !== "world-in-brief") {
    upstreamUrl.searchParams.set("limit", String(requestedLimit));
  }
  upstreamUrl.searchParams.set("format", "Atom");

  const response = await fetch(upstreamUrl, {
    headers: {
      accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
      "user-agent": "phoneclaw-economist-public-rss/1.0",
    },
  });
  const text = await response.text();

  if (!response.ok) {
    request.log.warn(
      {
        statusCode: response.status,
        topic,
      },
      "Economist RSS-Bridge upstream request failed"
    );
    return reply.code(502).send({ ok: false, status: "rss_bridge_upstream_failed" });
  }

  const cacheSeconds = clampInteger(process.env.ECONOMIST_PUBLIC_RSS_CACHE_SECONDS, 0, 3600, 900);

  return reply
    .code(200)
    .header("content-type", "application/atom+xml; charset=UTF-8")
    .header("cache-control", `private, max-age=${cacheSeconds}`)
    .header("x-robots-tag", "noindex, nofollow")
    .send(clampAtomFeedEntries(text, requestedLimit));
}

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

async function handleTwilioCall(request, reply, direction) {
  try {
    if (!isValidTwilioRequest(request)) {
      return reply.code(403).type("application/xml").send(sayTwiml("Unauthorized."));
    }

    const body = request.body || {};
    const fromNumber = body.From || body.from_number || body.fromNumber;
    const toNumber =
      body.To || body.to_number || body.toNumber || process.env.TWILIO_PHONE_NUMBER;

    if (!fromNumber || !toNumber) {
      return reply
        .code(200)
        .type("application/xml")
        .send(sayTwiml("The call did not include the phone number details this bridge needs."));
    }

    if (
      direction === "inbound" &&
      !isAllowedCaller(fromNumber, process.env.ALLOWED_CALLER_NUMBERS)
    ) {
      request.log.info(
        {
          event: "twilio_call_rejected",
          direction,
          from_last4: lastFourDigits(fromNumber),
          to_last4: lastFourDigits(toNumber),
          call_sid: body.CallSid,
        },
        "rejected non-allowlisted Twilio call"
      );
      return reply.code(200).type("application/xml").send(sayTwiml(outsideCoverageMessage));
    }

    if (!elevenLabsAgentId || !elevenLabsApiKey) {
      return reply
        .code(200)
        .type("application/xml")
        .send(sayTwiml("The ElevenLabs voice agent is not configured on this server yet."));
    }

    request.log.info(
      {
        event: "twilio_call",
        direction,
        from_last4: lastFourDigits(fromNumber),
        to_last4: lastFourDigits(toNumber),
        call_sid: body.CallSid,
      },
      "received Twilio call"
    );

    const twiml = await registerElevenLabsTwilioCall({
      direction,
      fromNumber,
      toNumber,
      callSid: body.CallSid,
      streamStatusCallbackUrl: twilioCallbackUrl(request, "/twilio/stream-status"),
    });

    return reply.code(200).type("application/xml").send(twiml);
  } catch (error) {
    request.log.error(error, "Twilio call handling failed");
    return reply
      .code(200)
      .type("application/xml")
      .send(sayTwiml("The voice agent connection failed. Please try again later."));
  }
}

async function registerElevenLabsTwilioCall({
  direction,
  fromNumber,
  toNumber,
  callSid,
  streamStatusCallbackUrl,
}) {
  const response = await fetch(
    `${elevenLabsApiBase}/v1/convai/twilio/register-call`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": elevenLabsApiKey,
      },
      body: JSON.stringify({
        agent_id: elevenLabsAgentId,
        from_number: fromNumber,
        to_number: toNumber,
        direction,
        conversation_initiation_client_data: {
          dynamic_variables: {
            caller_number: fromNumber,
            twilio_number: toNumber,
            twilio_call_sid: callSid || "",
            telephony_audio_format: ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
          },
        },
      }),
    }
  );

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `ElevenLabs register-call failed (${response.status}): ${text.slice(0, 800)}`
    );
  }

  return attachStreamStatusCallback(
    extractTwiml(text, contentType),
    streamStatusCallbackUrl
  );
}

async function handleTwilioStatusCallback(request, reply, source) {
  if (!isValidTwilioCallbackRequest(request)) {
    return reply.code(403).send({ ok: false, status: "unauthorized" });
  }

  const event = buildTwilioEvent({ source, payload: request.body || {} });
  twilioEvents.unshift(event);
  twilioEvents.splice(100);

  request.log.info(
    {
      event: "twilio_status_callback",
      id: event.id,
      source: event.source,
      event_type: event.event_type,
      call_sid: event.call_sid,
      stream_sid: event.stream_sid,
      stream_event: event.stream_event,
      call_status: event.call_status,
      from_last4: event.from_last4,
      to_last4: event.to_last4,
    },
    "received Twilio status callback"
  );

  return reply.code(200).send({ ok: true });
}

async function handleTwilioEvents(request, reply) {
  if (!isValidDiagnosticsRequest(request)) {
    return reply.code(401).send({ ok: false, status: "unauthorized" });
  }

  const query = request.query || {};
  const callSid = query.call_sid || query.callSid || "";
  const limit = clampInteger(query.limit, 1, 100, 30);
  const events = twilioEvents
    .filter((event) => !callSid || event.call_sid === callSid)
    .slice(0, limit);

  return reply.code(200).send({
    ok: true,
    call_sid: callSid || null,
    returned_count: events.length,
    events,
  });
}

async function handleAgentCommand(request, reply) {
  if (!commandBridgeToken) {
    return reply.code(503).send({
      ok: false,
      status: "tool_auth_not_configured",
      message: "COMMAND_BRIDGE_TOKEN is not set on this server.",
    });
  }

  const authHeader = request.headers.authorization || "";
  if (!secureEquals(authHeader, `Bearer ${commandBridgeToken}`)) {
    return reply.code(401).send({ ok: false, status: "unauthorized" });
  }

  const body = request.body || {};
  if (!body.command || typeof body.command !== "string") {
    return reply.code(400).send({
      ok: false,
      status: "missing_command",
      message: "A string command is required.",
    });
  }

  if (body.confirmed !== true && body.confirmed !== "true") {
    return reply.code(200).send({
      ok: false,
      status: "confirmation_required",
      message:
        "Ask the caller to confirm the exact command before sending it to Claude Code.",
    });
  }

  if (!claudeBridgeUrl) {
    return reply.code(200).send({
      ok: false,
      status: "bridge_not_configured",
      message: "The Claude Code bridge is not connected yet.",
    });
  }

  const headers = { "content-type": "application/json" };
  if (claudeBridgeToken) {
    headers.authorization = `Bearer ${claudeBridgeToken}`;
  }

  const upstreamResponse = await fetch(claudeBridgeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      command: body.command,
      working_directory: body.working_directory || body.workingDirectory || null,
      session_id: body.session_id || body.sessionId || null,
      caller_number: body.caller_number || body.callerNumber || null,
      source: "elevenlabs_voice_agent",
    }),
  });

  const upstreamText = await upstreamResponse.text();
  const upstreamBody = parseMaybeJson(upstreamText);

  if (!upstreamResponse.ok) {
    return reply.code(502).send({
      ok: false,
      status: "bridge_error",
      upstream_status: upstreamResponse.status,
      upstream_body: upstreamBody,
    });
  }

  return reply.code(200).send({
    ok: true,
    status: "forwarded",
    upstream_body: upstreamBody,
  });
}

async function handleWebSearch(request, reply) {
  if (!webSearchToken) {
    return reply.code(503).send({
      ok: false,
      status: "tool_auth_not_configured",
      message: "WEB_SEARCH_TOKEN is not configured on this server.",
    });
  }

  const authHeader = request.headers.authorization || "";
  if (!secureEquals(authHeader, `Bearer ${webSearchToken}`)) {
    return reply.code(401).send({ ok: false, status: "unauthorized" });
  }

  const body = request.body || {};
  const query = body.query || body.search_query || body.searchQuery;
  const maxResults = body.max_results || body.maxResults || 5;

  const result = await basicWebSearch({
    query,
    maxResults,
    provider: process.env.WEB_SEARCH_PROVIDER,
    tavilyApiKey: process.env.TAVILY_API_KEY,
    tavilySearchDepth: process.env.TAVILY_SEARCH_DEPTH,
  });
  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleGithubSummary(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  try {
    const body = request.body || {};
    const result = await githubSummaryGh({
      username: process.env.GITHUB_USERNAME,
      itemType: body.item_type || body.itemType || body.type || body.kind,
      scope: body.scope,
      maxResults: body.max_results || body.maxResults || 5,
      repo: body.repo || body.repository,
      owner: body.owner,
      organization: body.organization || body.org,
      maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
    });

    return reply.code(toolResultStatusCode(result)).send(result);
  } catch (error) {
    return reply.code(400).send(githubToolError(error));
  }
}

async function handleGithubCliLs(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  try {
    const body = request.body || {};
    const result = await githubCliLsGh({
      repo: body.repo || body.repository,
      path: body.path || "",
      ref: body.ref || body.branch || body.sha,
      recursive: body.recursive,
      maxEntries: body.max_entries || body.maxEntries,
      maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
    });

    return reply.code(toolResultStatusCode(result)).send(result);
  } catch (error) {
    return reply.code(400).send(githubToolError(error));
  }
}

async function handleGithubCliCat(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  try {
    const body = request.body || {};
    const result = await githubCliCatGh({
      repo: body.repo || body.repository,
      path: body.path,
      ref: body.ref || body.branch || body.sha,
      maxBytes: body.max_bytes || body.maxBytes,
      maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
    });

    return reply.code(toolResultStatusCode(result)).send(result);
  } catch (error) {
    return reply.code(400).send(githubToolError(error));
  }
}

async function handleGithubIssueCreate(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  try {
    const body = request.body || {};
    const result = await githubIssueCreateGh({
      repo: body.repo || body.repository,
      title: body.title,
      body: body.body,
      labels: body.labels,
      assignees: body.assignees,
      confirmed: body.confirmed,
      maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
    });

    return reply.code(toolResultStatusCode(result)).send(result);
  } catch (error) {
    return reply.code(400).send(githubToolError(error));
  }
}

async function handleGithubIssueUpdate(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  try {
    const body = request.body || {};
    const result = await githubIssueUpdateGh({
      repo: body.repo || body.repository,
      number: body.number,
      issueNumber: body.issue_number || body.issueNumber,
      title: body.title,
      body: body.body,
      state: body.state,
      stateReason: body.state_reason || body.stateReason,
      labels: body.labels,
      assignees: body.assignees,
      confirmed: body.confirmed,
      maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
    });

    return reply.code(toolResultStatusCode(result)).send(result);
  } catch (error) {
    return reply.code(400).send(githubToolError(error));
  }
}

async function handleHimalayaEmailList(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await himalayaEmailList({
    query: body.query || body.search_query || body.searchQuery,
    folder: body.folder,
    account: body.account,
    page: body.page,
    pageSize: body.page_size || body.pageSize || body.max_results || body.maxResults,
    allPages: body.all_pages ?? body.allPages,
    maxPages: body.max_pages || body.maxPages,
    maxItems: body.max_items || body.maxItems,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleHimalayaEmailRead(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await himalayaEmailRead({
    id: body.id || body.envelope_id || body.envelopeId,
    folder: body.folder,
    account: body.account,
    includeHeaders: body.include_headers ?? body.includeHeaders,
    markSeen: body.mark_seen ?? body.markSeen,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleHimalayaEmailArchive(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await himalayaEmailArchive({
    id: body.id || body.envelope_id || body.envelopeId,
    ids: body.ids || body.envelope_ids || body.envelopeIds,
    folder: body.folder,
    archiveFolder: body.archive_folder || body.archiveFolder,
    account: body.account,
    confirmed: body.confirmed,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply
    .code(result.ok || result.status === "confirmation_required" ? 200 : 400)
    .send(result);
}

async function handleHimalayaDraftCreate(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await himalayaDraftCreate({
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: body.subject,
    body: body.body || body.message,
    draftFolder: body.draft_folder || body.draftFolder,
    account: body.account,
    confirmed: body.confirmed,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply
    .code(result.ok || result.status === "confirmation_required" ? 200 : 400)
    .send(result);
}

async function handleHimalayaDraftReply(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await himalayaDraftReply({
    id: body.id || body.envelope_id || body.envelopeId,
    folder: body.folder,
    body: body.body || body.message,
    replyAll: body.reply_all ?? body.replyAll,
    draftFolder: body.draft_folder || body.draftFolder,
    account: body.account,
    confirmed: body.confirmed,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply
    .code(result.ok || result.status === "confirmation_required" ? 200 : 400)
    .send(result);
}

async function handleHimalayaEmailForward(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await himalayaEmailForward({
    id: body.id || body.envelope_id || body.envelopeId,
    folder: body.folder,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: body.subject,
    body: body.body || body.message,
    draftFolder: body.draft_folder || body.draftFolder,
    account: body.account,
    confirmed: body.confirmed,
    maxOriginalBytes:
      body.max_original_bytes || body.maxOriginalBytes || body.max_raw_bytes || body.maxRawBytes,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply
    .code(result.ok || result.status === "confirmation_required" ? 200 : 400)
    .send(result);
}

async function handleCreateReplyAllDraft(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await himalayaCreateReplyAllDraft({
    id: body.id || body.envelope_id || body.envelopeId,
    folder: body.folder,
    body: body.body || body.message,
    draftFolder: body.draft_folder || body.draftFolder,
    account: body.account,
    confirmed: body.confirmed,
    maxOriginalBytes:
      body.max_original_bytes || body.maxOriginalBytes || body.max_raw_bytes || body.maxRawBytes,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply
    .code(result.ok || result.status === "confirmation_required" ? 200 : 400)
    .send(result);
}

async function handleCreateForwardDraft(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await himalayaCreateForwardDraft({
    id: body.id || body.envelope_id || body.envelopeId,
    folder: body.folder,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: body.subject,
    body: body.body || body.message,
    draftFolder: body.draft_folder || body.draftFolder,
    account: body.account,
    confirmed: body.confirmed,
    maxOriginalBytes:
      body.max_original_bytes || body.maxOriginalBytes || body.max_raw_bytes || body.maxRawBytes,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply
    .code(result.ok || result.status === "confirmation_required" ? 200 : 400)
    .send(result);
}

async function handleHimalayaEmailSend(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await himalayaEmailSend({
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: body.subject,
    body: body.body || body.message,
    account: body.account,
    emergency: body.emergency,
    previewed: body.previewed,
    confirmed: body.confirmed,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply
    .code(result.ok || result.status === "confirmation_required" ? 200 : 400)
    .send(result);
}

async function handleOtterSpeechesList(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await otterSpeechesList({
    source: body.source,
    days: body.days,
    pageSize: body.page_size || body.pageSize || body.max_results || body.maxResults,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleOtterSpeechGet(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await otterSpeechGet({
    speechId: body.speech_id || body.speechId || body.otid || body.id,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleOtterSpeechSearch(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await otterSpeechSearch({
    speechId: body.speech_id || body.speechId || body.otid || body.id,
    query: body.query || body.search_query || body.searchQuery,
    speaker: body.speaker || body.speaker_name || body.speakerName,
    size: body.size || body.max_results || body.maxResults,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleGithubCliCommon(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await githubCliCommon({
    action: body.action,
    repo: body.repo || body.repository,
    number: body.number || body.issue_number || body.issueNumber || body.pr_number || body.prNumber,
    state: body.state,
    query: body.query || body.search_query || body.searchQuery,
    limit: body.limit || body.max_results || body.maxResults,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleRssRecentEconomistEntries(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await rssRecentEntries({
    limit: body.limit || body.max_results || body.maxResults,
    status: body.status,
    maxExcerptChars: body.max_excerpt_chars || body.maxExcerptChars,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleRssSearchEconomistEntries(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await rssSearchEntries({
    query: body.query || body.search_query || body.searchQuery,
    startDate: body.start_date || body.startDate,
    endDate: body.end_date || body.endDate,
    limit: body.limit || body.max_results || body.maxResults,
    status: body.status,
    maxExcerptChars: body.max_excerpt_chars || body.maxExcerptChars,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleRssGetEconomistArticleText(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await rssEntryFullText({
    entryId: body.entry_id || body.entryId || body.id,
    articleUrl: body.article_url || body.articleUrl || body.url,
    fetchOriginal: body.fetch_original ?? body.fetchOriginal,
    updateContent: body.update_content ?? body.updateContent,
    maxTextChars: body.max_text_chars || body.maxTextChars,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleRssRefreshEconomistFeeds(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const result = await rssRefreshFeeds();

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleRssListFeeds(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const result = await rssListConfiguredFeeds();

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleRssRecentEntries(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await rssConfiguredRecentEntries({
    feedId: body.feed_id || body.feedId,
    limit: body.limit || body.max_results || body.maxResults,
    maxExcerptChars: body.max_excerpt_chars || body.maxExcerptChars,
    refresh: body.refresh,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleRssSearchEntries(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await rssConfiguredSearchEntries({
    feedId: body.feed_id || body.feedId,
    query: body.query || body.search_query || body.searchQuery,
    startDate: body.start_date || body.startDate,
    endDate: body.end_date || body.endDate,
    limit: body.limit || body.max_results || body.maxResults,
    maxExcerptChars: body.max_excerpt_chars || body.maxExcerptChars,
    refresh: body.refresh,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleRssGetArticleText(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await rssConfiguredEntryFullText({
    entryId: body.entry_id || body.entryId || body.id,
    articleUrl: body.article_url || body.articleUrl || body.url,
    feedId: body.feed_id || body.feedId,
    maxTextChars: body.max_text_chars || body.maxTextChars,
    refresh: body.refresh,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleRssRefreshFeeds(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await rssRefreshConfiguredFeeds({
    feedId: body.feed_id || body.feedId,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleClaudeCodeTool(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await claudeCodeTool({
    action: body.action,
    task: body.task || body.command || body.prompt,
    repoPath:
      body.repo_path || body.repoPath || body.working_directory || body.workingDirectory,
    sessionId: body.session_id || body.sessionId,
    jobId: body.job_id || body.jobId,
    mode: body.mode,
    instructions:
      body.instructions ||
      body.steering_instructions ||
      body.steeringInstructions ||
      body.message,
    confirmed: body.confirmed,
    maxSeconds: body.max_seconds || body.maxSeconds,
  });

  return reply
    .code(isClaudeCodeToolResponse(result) ? 200 : 400)
    .send(result);
}

async function handleConversationHistorySearch(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await conversationHistorySearch({
    query: body.query || body.search_query || body.searchQuery,
    startDate: body.start_date || body.startDate,
    endDate: body.end_date || body.endDate,
    limit: body.limit || body.max_results || body.maxResults,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleConversationHistoryGet(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await conversationHistoryGet({
    conversationId: body.conversation_id || body.conversationId || body.id,
    includeTranscript: body.include_transcript || body.includeTranscript,
    includeToolDetails: body.include_tool_details || body.includeToolDetails,
    maxTranscriptTurns: body.max_transcript_turns || body.maxTranscriptTurns,
    maxToolItems: body.max_tool_items || body.maxToolItems,
  });

  return reply.code(result.ok ? 200 : 400).send(result);
}

async function handleConversationRecentContext(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await conversationRecentContext({
    limit: body.limit || body.max_results || body.maxResults,
  });

  return reply.code(result.ok ? 200 : 400).send(result);
}

async function handleConversationArchiveElevenLabs(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = body.latest || body.latest_conversations || body.latestConversations
    ? await archiveLatestElevenLabsConversations({
        limit: body.limit || body.max_results || body.maxResults,
      })
    : await archiveElevenLabsConversation({
        conversationId: body.conversation_id || body.conversationId || body.id,
      });

  return reply.code(result.ok ? 200 : 400).send(result);
}

function isClaudeCodeToolResponse(result) {
  return (
    result.ok ||
    [
      "confirmation_required",
      "claude_not_authenticated",
      "job_not_found",
      "session_ready",
      "steering_recorded",
      "working_directory_not_allowed",
    ].includes(result.status)
  );
}

function toolResultStatusCode(result) {
  if (result.ok) return 200;
  if (
    [
      "confirmation_required",
      "conversation_history_not_configured",
      "cli_bridge_not_configured",
      "miniflux_not_configured",
      "rss_feeds_not_configured",
      "tool_auth_not_configured",
    ].includes(result.status)
  ) {
    return 200;
  }
  return 400;
}

function validateToolAuth(request, reply) {
  if (!webSearchToken) {
    reply.code(503).send({
      ok: false,
      status: "tool_auth_not_configured",
      message: "WEB_SEARCH_TOKEN is not configured on this server.",
    });
    return false;
  }

  const authHeader = request.headers.authorization || "";
  if (!secureEquals(authHeader, `Bearer ${webSearchToken}`)) {
    reply.code(401).send({ ok: false, status: "unauthorized" });
    return false;
  }

  return true;
}

function validateCliToolAuth(request, reply) {
  const expectedToken = cliBridgeToken || webSearchToken;
  if (!expectedToken) {
    reply.code(503).send({
      ok: false,
      status: "cli_tool_auth_not_configured",
      message:
        "CLI_BRIDGE_TOKEN is not configured on this server. WEB_SEARCH_TOKEN can be used only for local development.",
    });
    return false;
  }

  const authHeader = request.headers.authorization || "";
  if (!secureEquals(authHeader, `Bearer ${expectedToken}`)) {
    reply.code(401).send({ ok: false, status: "unauthorized" });
    return false;
  }

  return true;
}

function isValidEconomistPublicRssRequest(request) {
  if (!economistPublicRssToken) return false;

  const queryToken = request.query?.token;
  if (queryToken && secureEquals(queryToken, economistPublicRssToken)) return true;

  const authHeader = request.headers.authorization || "";
  if (secureEquals(authHeader, `Bearer ${economistPublicRssToken}`)) return true;

  if (authHeader.toLowerCase().startsWith("basic ")) {
    const encoded = authHeader.slice("basic ".length).trim();
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const password = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
    return secureEquals(password, economistPublicRssToken);
  }

  return false;
}

function githubToolError(error) {
  return {
    ok: false,
    status: "github_tool_error",
    message: error?.message || "GitHub tool request failed.",
    entries: [],
  };
}

function isValidTwilioRequest(request) {
  if (!enforceTwilioSignature) return true;

  const signature = request.headers["x-twilio-signature"];
  if (!signature) return false;

  return validateRequest(
    twilioAuthToken,
    signature,
    publicRequestUrl(request),
    request.body || {}
  );
}

function isValidTwilioCallbackRequest(request) {
  if (process.env.TWILIO_WEBHOOK_TOKEN) {
    const token = request.query?.token;
    if (token !== process.env.TWILIO_WEBHOOK_TOKEN) return false;
  }

  return isValidTwilioRequest(request);
}

function isValidDiagnosticsRequest(request) {
  if (request.query?.token && request.query.token === process.env.TWILIO_WEBHOOK_TOKEN) {
    return true;
  }

  if (!webSearchToken) return false;

  const authHeader = request.headers.authorization || "";
  return secureEquals(authHeader, `Bearer ${webSearchToken}`);
}

function twilioCallbackUrl(request, pathname) {
  const url = new URL(publicRequestUrl(request));
  url.pathname = pathname;
  url.search = "";

  if (process.env.TWILIO_WEBHOOK_TOKEN) {
    url.searchParams.set("token", process.env.TWILIO_WEBHOOK_TOKEN);
  }

  return url.toString();
}

function publicRequestUrl(request) {
  const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const proto = forwardedProto || request.protocol || "https";
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const hostHeader = forwardedHost || request.headers.host;
  return `${proto}://${hostHeader}${request.url}`;
}

function redactUrlForLogs(value) {
  try {
    const url = new URL(String(value || ""), "https://phoneclaw.local");
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|key|password|signature/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return String(value || "").replace(
      /([?&][^=]*(?:token|secret|key|password|signature)[^=]*=)[^&]*/gi,
      "$1[redacted]"
    );
  }
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  return value?.split(",")[0]?.trim();
}

function extractTwiml(text, contentType) {
  if (contentType.includes("application/json")) {
    const parsed = parseMaybeJson(text);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed?.twiml === "string") return parsed.twiml;
  }

  return text;
}

function clampAtomFeedEntries(xml, maxEntries) {
  const text = String(xml || "");
  const entries = [...text.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)];
  if (entries.length <= maxEntries) return text;

  const selectedEntries = entries.slice(0, maxEntries).map((entry) => entry[0]).join("\n");
  const firstEntry = entries[0];
  const lastEntry = entries.at(-1);
  return [
    text.slice(0, firstEntry.index),
    selectedEntries,
    text.slice(lastEntry.index + lastEntry[0].length),
  ].join("");
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sayTwiml(message) {
  return `<Response><Say>${escapeXml(message)}</Say></Response>`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
