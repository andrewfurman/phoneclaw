import {
  ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
} from "../shared/telephony-audio-format.mjs";
import { basicWebSearch } from "../shared/basic-web-search.mjs";
import {
  isAllowedCaller,
  lastFourDigits,
  parseAllowedCallerNumbers,
} from "../shared/phone-numbers.mjs";
import {
  attachStreamStatusCallback,
  buildTwilioEvent,
  summarizeTwilioEvent,
} from "../shared/twilio-events.mjs";

const XML_HEADERS = {
  "content-type": "application/xml; charset=utf-8",
  "cache-control": "no-store",
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const OUTSIDE_COVERAGE_MESSAGE =
  "Thanks for calling Andrew's assistance line. Sorry we haven't set up outside coverage yet.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        elevenlabs_agent_configured: Boolean(
          env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID
        ),
        command_bridge_configured: Boolean(env.CLAUDE_BRIDGE_URL),
        web_search_configured: Boolean(env.WEB_SEARCH_TOKEN || env.COMMAND_BRIDGE_TOKEN),
        web_search_provider:
          env.WEB_SEARCH_PROVIDER || (env.TAVILY_API_KEY ? "auto" : "duckduckgo"),
        cli_bridge_configured: Boolean(env.CLI_BRIDGE_URL && env.CLI_BRIDGE_TOKEN),
        github_cli_bridge_configured: Boolean(env.CLI_BRIDGE_URL && env.CLI_BRIDGE_TOKEN),
        expected_elevenlabs_audio_format:
          env.ELEVENLABS_TELEPHONY_AUDIO_FORMAT || ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
        allowed_caller_numbers_configured: parseAllowedCallerNumbers(
          env.ALLOWED_CALLER_NUMBERS
        ).length > 0,
        twilio_webhook_token_required: Boolean(env.TWILIO_WEBHOOK_TOKEN),
        twilio_event_log_configured: Boolean(env.TWILIO_EVENT_LOGS),
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json({
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
          himalaya_email_send: "POST /cli/himalaya/email-send",
          otter_speeches_list: "POST /cli/otter/speeches-list",
          otter_speech_get: "POST /cli/otter/speech-get",
          otter_speech_search: "POST /cli/otter/speech-search",
          github_cli_common: "POST /cli/github/common",
          rss_recent_economist_entries: "POST /cli/rss/economist/recent",
          rss_search_economist_entries: "POST /cli/rss/economist/search",
          rss_get_economist_article_text: "POST /cli/rss/economist/article-text",
          rss_refresh_economist_feeds: "POST /cli/rss/economist/refresh",
          claude_code: "POST /cli/claude-code",
          conversation_history_search: "POST /conversation-history/search",
          conversation_history_get: "POST /conversation-history/get",
          conversation_history_recent_context: "POST /conversation-history/recent-context",
          conversation_history_archive: "POST /conversation-history/archive-elevenlabs",
          future_claude_tool: "POST /agent-command",
          health: "GET /health",
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/twilio/inbound") {
      return handleTwilioCall(request, env, "inbound");
    }

    if (
      (request.method === "GET" || request.method === "POST") &&
      url.pathname === "/twilio/test-say"
    ) {
      if (!isValidTwilioWebhookRequest(request, env)) {
        return xml(sayTwiml("Unauthorized."), 403);
      }

      return xml(
        sayTwiml(
          "Hello. This is a Twilio audio test from Cloudflare. If this sounds clear, the phone line is working."
        )
      );
    }

    if (request.method === "POST" && url.pathname === "/twilio/outbound") {
      return handleTwilioCall(request, env, "outbound");
    }

    if (request.method === "POST" && url.pathname === "/twilio/stream-status") {
      return handleTwilioStatusCallback(request, env, ctx, "twilio_stream_status");
    }

    if (request.method === "POST" && url.pathname === "/twilio/call-status") {
      return handleTwilioStatusCallback(request, env, ctx, "twilio_call_status");
    }

    if (request.method === "GET" && url.pathname === "/twilio/events") {
      return handleTwilioEvents(request, env);
    }

    if (request.method === "POST" && url.pathname === "/agent-command") {
      return handleAgentCommand(request, env);
    }

    if (request.method === "POST" && url.pathname === "/web-search") {
      return handleWebSearch(request, env);
    }

    if (
      request.method === "POST" &&
      [
        "/github-summary",
        "/github-cli/ls",
        "/github-cli/cat",
        "/github-issues/create",
        "/github-issues/update",
        "/cli/himalaya/email-list",
        "/cli/himalaya/email-read",
        "/cli/himalaya/email-archive",
        "/cli/himalaya/draft-create",
        "/cli/himalaya/draft-reply",
        "/cli/himalaya/email-forward",
        "/cli/himalaya/email-send",
        "/cli/otter/speeches-list",
        "/cli/otter/speech-get",
        "/cli/otter/speech-search",
        "/cli/github/common",
        "/cli/rss/economist/recent",
        "/cli/rss/economist/search",
        "/cli/rss/economist/article-text",
        "/cli/rss/economist/refresh",
        "/cli/claude-code",
        "/conversation-history/search",
        "/conversation-history/get",
        "/conversation-history/recent-context",
        "/conversation-history/archive-elevenlabs",
      ].includes(url.pathname)
    ) {
      return handleCliBridgeProxy(request, env, url.pathname);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
};

async function handleTwilioCall(request, env, direction) {
  try {
    if (!isValidTwilioWebhookRequest(request, env)) {
      return xml(sayTwiml("Unauthorized."), 403);
    }

    const body = await parseRequestBody(request);
    const fromNumber = body.From || body.from_number || body.fromNumber;
    const toNumber =
      body.To || body.to_number || body.toNumber || env.TWILIO_PHONE_NUMBER;

    if (!fromNumber || !toNumber) {
      return xml(
        sayTwiml("The call did not include the phone number details this bridge needs.")
      );
    }

    if (direction === "inbound" && !isAllowedCaller(fromNumber, env.ALLOWED_CALLER_NUMBERS)) {
      console.log(
        JSON.stringify({
          event: "twilio_call_rejected",
          direction,
          from_last4: lastFourDigits(fromNumber),
          to_last4: lastFourDigits(toNumber),
          call_sid: body.CallSid,
        })
      );
      return xml(sayTwiml(env.OUTSIDE_COVERAGE_MESSAGE || OUTSIDE_COVERAGE_MESSAGE));
    }

    if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID) {
      return xml(
        sayTwiml("The ElevenLabs voice agent is not configured on this server yet.")
      );
    }

    console.log(
      JSON.stringify({
        event: "twilio_call",
        direction,
        from_last4: lastFourDigits(fromNumber),
        to_last4: lastFourDigits(toNumber),
        call_sid: body.CallSid,
      })
    );

    const recentConversationContext = await loadRecentConversationContext(env);
    const twiml = await registerElevenLabsTwilioCall(env, {
      direction,
      fromNumber,
      toNumber,
      callSid: body.CallSid,
      streamStatusCallbackUrl: twilioCallbackUrl(request, env, "/twilio/stream-status"),
      recentConversationContext,
    });

    return xml(twiml);
  } catch (error) {
    console.error(error);
    return xml(sayTwiml("The voice agent connection failed. Please try again later."));
  }
}

async function registerElevenLabsTwilioCall(
  env,
  { direction, fromNumber, toNumber, callSid, streamStatusCallbackUrl, recentConversationContext }
) {
  const apiBase = env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
  const response = await fetch(`${apiBase}/v1/convai/twilio/register-call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": env.ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      agent_id: env.ELEVENLABS_AGENT_ID,
      from_number: fromNumber,
      to_number: toNumber,
      direction,
      conversation_initiation_client_data: {
        dynamic_variables: {
          caller_number: fromNumber,
          twilio_number: toNumber,
            twilio_call_sid: callSid || "",
            telephony_audio_format:
              env.ELEVENLABS_TELEPHONY_AUDIO_FORMAT || ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
            recent_conversation_context: recentConversationContext || "",
          },
        },
      }),
  });

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

async function handleTwilioStatusCallback(request, env, ctx, source) {
  if (!isValidTwilioWebhookRequest(request, env)) {
    return json({ ok: false, status: "unauthorized" }, 403);
  }

  const body = await parseRequestBody(request);
  const event = buildTwilioEvent({ source, payload: body });

  console.log(JSON.stringify({ event: "twilio_status_callback", ...summarizeTwilioEvent(event) }));

  const backgroundTasks = [recordTwilioEvent(env, event)];
  if (shouldArchiveAfterTwilioEvent(env, event)) {
    backgroundTasks.push(triggerConversationArchive(env, event));
  }

  if (ctx?.waitUntil) {
    ctx.waitUntil(Promise.allSettled(backgroundTasks));
  } else {
    await Promise.allSettled(backgroundTasks);
  }

  return json({ ok: true });
}

async function handleTwilioEvents(request, env) {
  if (!isValidDiagnosticsRequest(request, env)) {
    return json({ ok: false, status: "unauthorized" }, 401);
  }

  if (!env.TWILIO_EVENT_LOGS) {
    return json(
      {
        ok: false,
        status: "event_log_not_configured",
        message: "TWILIO_EVENT_LOGS KV binding is not configured.",
        events: [],
      },
      503
    );
  }

  const url = new URL(request.url);
  const callSid = url.searchParams.get("call_sid") || url.searchParams.get("callSid");
  const limit = clampInteger(url.searchParams.get("limit"), 1, 100, 30);
  const events = callSid
    ? await readTwilioEventsForCall(env, callSid, limit)
    : await readLatestTwilioEvents(env, limit);

  return json({
    ok: true,
    call_sid: callSid || null,
    returned_count: events.length,
    events,
  });
}

async function handleAgentCommand(request, env) {
  if (!env.COMMAND_BRIDGE_TOKEN) {
    return json(
      {
        ok: false,
        status: "tool_auth_not_configured",
        message: "COMMAND_BRIDGE_TOKEN is not configured on this Worker.",
      },
      503
    );
  }

  const authHeader = request.headers.get("authorization") || "";
  if (authHeader !== `Bearer ${env.COMMAND_BRIDGE_TOKEN}`) {
    return json({ ok: false, status: "unauthorized" }, 401);
  }

  const body = await parseRequestBody(request);
  if (!body.command || typeof body.command !== "string") {
    return json(
      {
        ok: false,
        status: "missing_command",
        message: "A string command is required.",
      },
      400
    );
  }

  if (body.confirmed !== true && body.confirmed !== "true") {
    return json({
      ok: false,
      status: "confirmation_required",
      message:
        "Ask the caller to confirm the exact command before sending it to Claude Code.",
    });
  }

  if (!env.CLAUDE_BRIDGE_URL) {
    return json({
      ok: false,
      status: "bridge_not_configured",
      message: "The Claude Code bridge is not connected yet.",
    });
  }

  const headers = { "content-type": "application/json" };
  if (env.CLAUDE_BRIDGE_TOKEN) {
    headers.authorization = `Bearer ${env.CLAUDE_BRIDGE_TOKEN}`;
  }

  const upstreamResponse = await fetch(env.CLAUDE_BRIDGE_URL, {
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
    return json(
      {
        ok: false,
        status: "bridge_error",
        upstream_status: upstreamResponse.status,
        upstream_body: upstreamBody,
      },
      502
    );
  }

  return json({
    ok: true,
    status: "forwarded",
    upstream_body: upstreamBody,
  });
}

async function handleWebSearch(request, env) {
  const toolToken = env.WEB_SEARCH_TOKEN || env.COMMAND_BRIDGE_TOKEN;
  if (!toolToken) {
    return json(
      {
        ok: false,
        status: "tool_auth_not_configured",
        message: "WEB_SEARCH_TOKEN is not configured on this Worker.",
      },
      503
    );
  }

  const authHeader = request.headers.get("authorization") || "";
  if (authHeader !== `Bearer ${toolToken}`) {
    return json({ ok: false, status: "unauthorized" }, 401);
  }

  const body = await parseRequestBody(request);
  const query = body.query || body.search_query || body.searchQuery;
  const maxResults = body.max_results || body.maxResults || 5;

  const result = await basicWebSearch({
    query,
    maxResults,
    provider: env.WEB_SEARCH_PROVIDER,
    tavilyApiKey: env.TAVILY_API_KEY,
    tavilySearchDepth: env.TAVILY_SEARCH_DEPTH,
  });
  return json(result, result.ok ? 200 : 400);
}

async function handleCliBridgeProxy(request, env, pathname) {
  const auth = validateToolAuth(request, env);
  if (auth) return auth;

  if (!env.CLI_BRIDGE_URL || !env.CLI_BRIDGE_TOKEN) {
    return json(
      {
        ok: false,
        status: "cli_bridge_not_configured",
        message:
          "The public Worker is ready, but CLI_BRIDGE_URL and CLI_BRIDGE_TOKEN must point to a private Fastify CLI bridge before Himalaya, Otter, or local gh commands can run.",
      },
      200
    );
  }

  const baseUrl = env.CLI_BRIDGE_URL.endsWith("/")
    ? env.CLI_BRIDGE_URL
    : `${env.CLI_BRIDGE_URL}/`;
  const upstreamUrl = new URL(pathname.replace(/^\//, ""), baseUrl);
  const bodyText = await request.text();

  const upstreamResponse = await fetch(upstreamUrl.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.CLI_BRIDGE_TOKEN}`,
    },
    body: bodyText || "{}",
  });
  const responseText = await upstreamResponse.text();

  return new Response(responseText, {
    status: upstreamResponse.status,
    headers: JSON_HEADERS,
  });
}

async function loadRecentConversationContext(env) {
  if (!env.CLI_BRIDGE_URL || !env.CLI_BRIDGE_TOKEN) return "";

  try {
    const baseUrl = env.CLI_BRIDGE_URL.endsWith("/")
      ? env.CLI_BRIDGE_URL
      : `${env.CLI_BRIDGE_URL}/`;
    const upstreamUrl = new URL("conversation-history/recent-context", baseUrl);
    const response = await fetchWithTimeout(upstreamUrl.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.CLI_BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({ limit: 10 }),
    }, 1_500);
    if (!response.ok) return "";

    const body = await response.json().catch(() => ({}));
    return body.ok && body.context_text ? String(body.context_text).slice(0, 6_000) : "";
  } catch {
    return "";
  }
}

function shouldArchiveAfterTwilioEvent(env, event) {
  if (String(env.AUTO_ARCHIVE_CONVERSATIONS_ON_CALL_END || "true").toLowerCase() === "false") {
    return false;
  }
  if (!env.CLI_BRIDGE_URL || !env.CLI_BRIDGE_TOKEN) return false;
  if (event.source !== "twilio_call_status") return false;

  const status = String(event.call_status || event.event_type || "").toLowerCase();
  return ["completed", "canceled", "busy", "failed", "no-answer"].includes(status);
}

async function triggerConversationArchive(env, event) {
  try {
    const baseUrl = env.CLI_BRIDGE_URL.endsWith("/")
      ? env.CLI_BRIDGE_URL
      : `${env.CLI_BRIDGE_URL}/`;
    const upstreamUrl = new URL("conversation-history/archive-elevenlabs", baseUrl);
    const limit = clampInteger(env.AUTO_ARCHIVE_CONVERSATION_LIMIT, 1, 20, 5);
    const response = await fetchWithTimeout(upstreamUrl.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.CLI_BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({
        latest: true,
        limit,
        source: "twilio_call_status",
        twilio_call_sid: event.call_sid || "",
      }),
    }, 9_000);
    const body = await response.json().catch(() => ({}));
    console.log(
      JSON.stringify({
        event: "conversation_archive_triggered",
        ok: response.ok && body.ok !== false,
        status: body.status || response.status,
        call_sid: event.call_sid || "",
        archived_count: body.archived_count ?? null,
      })
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "conversation_archive_failed",
        call_sid: event.call_sid || "",
        message: error?.message || String(error),
      })
    );
  }
}

function fetchWithTimeout(url, options, timeoutMs) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("request_timeout")), timeoutMs)
  );
  return Promise.race([fetch(url, options), timeout]);
}

function validateToolAuth(request, env) {
  const toolToken = env.WEB_SEARCH_TOKEN || env.COMMAND_BRIDGE_TOKEN;
  if (!toolToken) {
    return json(
      {
        ok: false,
        status: "tool_auth_not_configured",
        message: "WEB_SEARCH_TOKEN is not configured on this Worker.",
      },
      503
    );
  }

  const authHeader = request.headers.get("authorization") || "";
  if (authHeader !== `Bearer ${toolToken}`) {
    return json({ ok: false, status: "unauthorized" }, 401);
  }

  return null;
}

function isValidTwilioWebhookRequest(request, env) {
  if (!env.TWILIO_WEBHOOK_TOKEN) return true;
  const url = new URL(request.url);
  return url.searchParams.get("token") === env.TWILIO_WEBHOOK_TOKEN;
}

function isValidDiagnosticsRequest(request, env) {
  if (isValidTwilioWebhookRequest(request, env)) return true;

  const toolToken = env.WEB_SEARCH_TOKEN || env.COMMAND_BRIDGE_TOKEN;
  if (!toolToken) return false;

  const authHeader = request.headers.get("authorization") || "";
  return authHeader === `Bearer ${toolToken}`;
}

function twilioCallbackUrl(request, env, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";

  const token = env.TWILIO_WEBHOOK_TOKEN;
  if (token) {
    url.searchParams.set("token", token);
  }

  return url.toString();
}

async function recordTwilioEvent(env, event) {
  if (!env.TWILIO_EVENT_LOGS) return;

  const ttl = clampInteger(env.TWILIO_EVENT_LOG_TTL_SECONDS, 60, 2_592_000, 604_800);
  const eventKey = twilioEventKey(event);
  await env.TWILIO_EVENT_LOGS.put(eventKey, JSON.stringify(event), {
    expirationTtl: ttl,
  });

  const latest = await readLatestTwilioEvents(env, 99);
  const nextLatest = [event, ...latest.filter((item) => item.id !== event.id)].slice(0, 100);
  await env.TWILIO_EVENT_LOGS.put("twilio-events/latest", JSON.stringify(nextLatest), {
    expirationTtl: ttl,
  });
}

async function readLatestTwilioEvents(env, limit) {
  const text = await env.TWILIO_EVENT_LOGS.get("twilio-events/latest");
  if (!text) return [];

  const parsed = parseMaybeJson(text);
  if (!Array.isArray(parsed)) return [];

  return parsed.slice(0, limit);
}

async function readTwilioEventsForCall(env, callSid, limit) {
  const prefix = `twilio-events/by-call/${callSid}/`;
  const listing = await env.TWILIO_EVENT_LOGS.list({ prefix, limit: Math.min(limit, 100) });
  const events = [];

  for (const key of listing.keys) {
    const text = await env.TWILIO_EVENT_LOGS.get(key.name);
    const parsed = parseMaybeJson(text);
    if (parsed && typeof parsed === "object") {
      events.push(parsed);
    }
  }

  return events
    .sort((left, right) => String(left.received_at).localeCompare(String(right.received_at)))
    .slice(-limit);
}

function twilioEventKey(event) {
  const callSid = event.call_sid || "unknown-call";
  return `twilio-events/by-call/${callSid}/${event.received_at}-${event.id}`;
}

async function parseRequestBody(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return request.json();
  }

  const text = await request.text();
  if (!text) return {};

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }

  return { raw_body: text };
}

function extractTwiml(text, contentType) {
  if (contentType.includes("application/json")) {
    const parsed = parseMaybeJson(text);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed?.twiml === "string") return parsed.twiml;
  }

  return text;
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function xml(body, status = 200) {
  return new Response(body, {
    status,
    headers: XML_HEADERS,
  });
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
