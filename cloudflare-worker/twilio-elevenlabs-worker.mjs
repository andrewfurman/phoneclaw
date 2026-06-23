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
import {
  visualizerAssets,
  visualizerHtml,
} from "./visualizer-assets.generated.mjs";

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
const VISUALIZER_COOKIE = "phoneclaw_visualizer";
const VISUALIZER_SESSION_TTL_SECONDS = 86_400;
const VISUALIZER_HOSTS = new Set(["phoneclaw.aifurman.com"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (isVisualizerHost(url) && url.pathname === "/") {
      return redirectNoCookie("/visualizer/");
    }

    if (isVisualizerHost(url) && url.pathname.startsWith("/conversation/")) {
      return redirectNoCookie(`/visualizer${url.pathname}`);
    }

    if (url.pathname === "/visualizer" || url.pathname.startsWith("/visualizer/")) {
      return handleVisualizerRequest(request, env, ctx, url);
    }

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
          visualizer: "GET /visualizer",
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
        "/cli/himalaya/create-reply-all-draft",
        "/cli/himalaya/create-forward-draft",
        "/cli/himalaya/email-send",
        "/cli/otter/speeches-list",
        "/cli/otter/speech-get",
        "/cli/otter/speech-search",
        "/cli/github/common",
        "/cli/rss/economist/recent",
        "/cli/rss/economist/search",
        "/cli/rss/economist/article-text",
        "/cli/rss/economist/refresh",
        "/cli/rss/feeds",
        "/cli/rss/recent",
        "/cli/rss/search",
        "/cli/rss/article-text",
        "/cli/rss/refresh",
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

async function handleVisualizerRequest(request, env, ctx, url) {
  if (url.pathname === "/visualizer/logout") {
    return redirectWithCookie("/visualizer/login", expiredVisualizerCookie());
  }

  if (url.pathname === "/visualizer/login") {
    if (request.method === "GET") return visualizerLoginPage();
    if (request.method !== "POST") return json({ ok: false, status: "method_not_allowed" }, 405);
    return handleVisualizerLogin(request, env);
  }

  const authenticated = await isValidVisualizerSession(request, env);
  if (!authenticated) {
    if (url.pathname.startsWith("/visualizer/api/")) {
      return json({ ok: false, status: "unauthorized" }, 401);
    }
    return visualizerLoginPage();
  }

  if (url.pathname.startsWith("/visualizer/api/")) {
    return handleVisualizerApi(request, env, ctx, url);
  }

  const asset = visualizerAssets[url.pathname];
  if (asset) {
    return new Response(asset.body, {
      headers: {
        "content-type": asset.content_type,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  return new Response(visualizerHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

async function handleVisualizerLogin(request, env) {
  if (!env.VISUALIZER_PASSWORD) {
    return new Response(visualizerLoginHtml("Visualizer password is not configured."), {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const body = await parseRequestBody(request);
  const password = String(body.password || "");
  if (!constantTimeStringEqual(password, env.VISUALIZER_PASSWORD)) {
    return new Response(visualizerLoginHtml("Incorrect password."), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const cookie = await signedVisualizerCookie(env);
  return redirectWithCookie("/visualizer/", cookie);
}

async function handleVisualizerApi(request, env, ctx, url) {
  if (request.method === "GET" && url.pathname === "/visualizer/api/bootstrap") {
    return handleVisualizerBootstrap(env, url);
  }

  if (request.method === "GET" && url.pathname.startsWith("/visualizer/api/conversations/")) {
    const conversationId = decodeURIComponent(
      url.pathname.replace("/visualizer/api/conversations/", "")
    );
    return handleVisualizerConversation(env, conversationId);
  }

  if (request.method === "POST" && url.pathname === "/visualizer/api/archive-latest") {
    const result = await postCliBridge(env, "/conversation-history/archive-elevenlabs", {
      latest: true,
      limit: 8,
      source: "visualizer",
    }, 12_000);
    if (ctx?.waitUntil) {
      ctx.waitUntil(Promise.resolve(result).catch(() => {}));
    }
    return json(result, result.ok === false ? 502 : 200);
  }

  if (request.method === "GET" && url.pathname === "/visualizer/api/twilio-events") {
    return json(await visualizerTwilioEvents(env, url));
  }

  return json({ ok: false, status: "not_found" }, 404);
}

async function handleVisualizerBootstrap(env, url) {
  const limit = clampInteger(url.searchParams.get("limit"), 1, 30, 12);
  const query = url.searchParams.get("query") || "";
  const [liveConversations, archivedConversations, twilioEvents] = await Promise.all([
    fetchElevenLabsLiveConversations(env, { limit: Math.min(limit, 12) }),
    postCliBridge(env, "/conversation-history/search", { query, limit }, 6_000),
    visualizerTwilioEvents(env, url),
  ]);

  return json({
    ok: true,
    generated_at: new Date().toISOString(),
    health: {
      elevenlabs_agent_configured: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID),
      cli_bridge_configured: Boolean(env.CLI_BRIDGE_URL && env.CLI_BRIDGE_TOKEN),
      twilio_event_log_configured: Boolean(env.TWILIO_EVENT_LOGS),
    },
    live_conversations: liveConversations,
    archived_conversations: normalizeArchivedConversationList(archivedConversations),
    twilio_events: twilioEvents,
  });
}

async function handleVisualizerConversation(env, conversationId) {
  if (!conversationId) {
    return json({ ok: false, status: "missing_conversation_id" }, 400);
  }

  const [live, archive] = await Promise.all([
    fetchElevenLabsConversationDetail(env, conversationId),
    postCliBridge(env, "/conversation-history/get", {
      conversation_id: conversationId,
      include_transcript: true,
      include_tool_details: true,
      max_transcript_turns: 50,
      max_tool_items: 50,
    }, 8_000),
  ]);

  const archivedConversation = archive?.conversation || null;
  const liveConversation = live?.conversation || null;
  if (!archivedConversation && !liveConversation) {
    return json({
      ok: false,
      status: "conversation_not_found",
      live_status: live?.status || "",
      archive_status: archive?.status || "",
    }, 404);
  }

  return json({
    ok: true,
    conversation: mergeVisualizerConversation(archivedConversation, liveConversation),
  });
}

async function fetchElevenLabsLiveConversations(env, { limit }) {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID) {
    return { ok: false, status: "elevenlabs_not_configured", items: [] };
  }

  try {
    const apiBase = env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
    const listUrl = new URL(`${apiBase}/v1/convai/conversations`);
    listUrl.searchParams.set("agent_id", env.ELEVENLABS_AGENT_ID);
    listUrl.searchParams.set("page_size", String(limit));
    const response = await fetchWithTimeout(listUrl.toString(), {
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    }, 7_000);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: "elevenlabs_conversation_list_failed",
        upstream_status: response.status,
        items: [],
      };
    }

    const conversations = body.conversations || body.items || body.data || [];
    const details = await Promise.all(
      conversations.slice(0, Math.min(limit, 6)).map((item) => {
        const id = item.conversation_id || item.id;
        return id ? fetchElevenLabsConversationDetail(env, id) : null;
      })
    );
    const detailMap = new Map(
      details
        .filter((item) => item?.conversation)
        .map((item) => [item.conversation.conversation_id, item.conversation])
    );

    return {
      ok: true,
      status: "ok",
      returned_count: conversations.length,
      items: conversations.map((item) => {
        const id = item.conversation_id || item.id;
        return normalizeLiveConversation(item, detailMap.get(id));
      }),
    };
  } catch (error) {
    return {
      ok: false,
      status: "elevenlabs_conversation_list_error",
      message: error?.message || String(error),
      items: [],
    };
  }
}

async function fetchElevenLabsConversationDetail(env, conversationId) {
  if (!env.ELEVENLABS_API_KEY) {
    return { ok: false, status: "elevenlabs_not_configured" };
  }

  try {
    const apiBase = env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
    const response = await fetchWithTimeout(
      `${apiBase}/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
      { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } },
      7_000
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: "elevenlabs_conversation_fetch_failed",
        upstream_status: response.status,
      };
    }

    return {
      ok: true,
      status: "ok",
      conversation: normalizeLiveConversation(body, body),
    };
  } catch (error) {
    return {
      ok: false,
      status: "elevenlabs_conversation_fetch_error",
      message: error?.message || String(error),
    };
  }
}

async function postCliBridge(env, pathname, body, timeoutMs) {
  if (!env.CLI_BRIDGE_URL || !env.CLI_BRIDGE_TOKEN) {
    return { ok: false, status: "cli_bridge_not_configured", items: [] };
  }

  try {
    const baseUrl = env.CLI_BRIDGE_URL.endsWith("/")
      ? env.CLI_BRIDGE_URL
      : `${env.CLI_BRIDGE_URL}/`;
    const upstreamUrl = new URL(pathname.replace(/^\//, ""), baseUrl);
    const response = await fetchWithTimeout(upstreamUrl.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.CLI_BRIDGE_TOKEN}`,
      },
      body: JSON.stringify(body || {}),
    }, timeoutMs);
    const text = await response.text();
    const parsed = parseMaybeJson(text);
    if (!response.ok) {
      return {
        ok: false,
        status: "cli_bridge_request_failed",
        upstream_status: response.status,
        message: typeof parsed === "string" ? parsed.slice(0, 300) : parsed?.message || "",
        items: [],
      };
    }
    return parsed;
  } catch (error) {
    return {
      ok: false,
      status: "cli_bridge_request_error",
      message: error?.message || String(error),
      items: [],
    };
  }
}

async function visualizerTwilioEvents(env, url) {
  if (!env.TWILIO_EVENT_LOGS) {
    return { ok: false, status: "event_log_not_configured", events: [] };
  }
  const limit = clampInteger(url.searchParams.get("event_limit"), 1, 100, 50);
  const callSid = url.searchParams.get("call_sid") || url.searchParams.get("callSid");
  const events = callSid
    ? await readTwilioEventsForCall(env, callSid, limit)
    : await readLatestTwilioEvents(env, limit);
  return { ok: true, status: "ok", returned_count: events.length, events };
}

function normalizeArchivedConversationList(result) {
  if (!result || result.ok === false) {
    return {
      ok: false,
      status: result?.status || "archive_unavailable",
      items: [],
      returned_count: 0,
    };
  }
  return {
    ...result,
    items: (result.items || []).map((item) => ({ ...item, source: "archive" })),
  };
}

function normalizeLiveConversation(summary, detail) {
  const id =
    detail?.conversation_id ||
    detail?.id ||
    summary?.conversation_id ||
    summary?.id ||
    "";
  const transcript = Array.isArray(detail?.transcript) ? detail.transcript : [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const startedAt =
    isoFromUnixSeconds(summary?.start_time_unix_secs || detail?.start_time_unix_secs) ||
    detail?.metadata?.start_time ||
    summary?.created_at ||
    detail?.created_at ||
    "";

  return {
    source: "live",
    conversation_id: id,
    twilio_call_sid:
      detail?.metadata?.twilio_call_sid ||
      detail?.conversation_initiation_client_data?.dynamic_variables?.twilio_call_sid ||
      "",
    caller_number: "",
    started_at: startedAt,
    ended_at: isoFromUnixSeconds(summary?.end_time_unix_secs || detail?.end_time_unix_secs),
    duration_seconds:
      summary?.call_duration_secs ??
      summary?.duration_seconds ??
      detail?.metadata?.call_duration_secs ??
      detail?.duration_seconds ??
      null,
    status: detail?.status || summary?.status || summary?.call_successful || "",
    summary:
      detail?.analysis?.transcript_summary ||
      detail?.transcript_summary ||
      firstTranscriptMessage(transcript) ||
      "",
    keywords: detail?.analysis?.topics || [],
    tool_call_count: toolCalls.length || summary?.tool_call_count || 0,
    transcript_turn_count: transcript.length,
    transcript,
    transcript_excerpt: transcript,
    tool_calls: toolCalls,
    tool_results: toolResults,
    metadata: compactLiveMetadata(summary, detail),
  };
}

function mergeVisualizerConversation(archivedConversation, liveConversation) {
  if (!archivedConversation) return liveConversation;
  if (!liveConversation) return { ...archivedConversation, source: "archive" };
  return {
    ...archivedConversation,
    ...liveConversation,
    source: liveConversation.source || "live",
    summary: archivedConversation.summary || liveConversation.summary,
    keywords: archivedConversation.keywords?.length
      ? archivedConversation.keywords
      : liveConversation.keywords,
    tool_calls: liveConversation.tool_calls?.length
      ? liveConversation.tool_calls
      : archivedConversation.tool_calls,
    tool_results: liveConversation.tool_results?.length
      ? liveConversation.tool_results
      : archivedConversation.tool_results,
    metadata: {
      ...(archivedConversation.metadata || {}),
      ...(liveConversation.metadata || {}),
    },
  };
}

function compactLiveMetadata(summary, detail) {
  return {
    call_successful: summary?.call_successful || detail?.call_successful || "",
    message_count: summary?.message_count || detail?.message_count || null,
    has_audio: summary?.has_audio ?? detail?.has_audio ?? null,
  };
}

function firstTranscriptMessage(transcript) {
  return (
    transcript.find((turn) => turn.role === "user" && turn.message)?.message ||
    transcript.find((turn) => turn.role === "agent" && turn.message && turn.message !== "...")?.message ||
    ""
  );
}

function isoFromUnixSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  return new Date(number * 1000).toISOString();
}

async function signedVisualizerCookie(env) {
  const expiresAt = Math.floor(Date.now() / 1000) + VISUALIZER_SESSION_TTL_SECONDS;
  const payload = base64UrlEncode(JSON.stringify({ exp: expiresAt }));
  const signature = await hmacSign(payload, visualizerSessionSecret(env));
  return `${VISUALIZER_COOKIE}=${payload}.${signature}; Path=/visualizer; Max-Age=${VISUALIZER_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function expiredVisualizerCookie() {
  return `${VISUALIZER_COOKIE}=; Path=/visualizer; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

async function isValidVisualizerSession(request, env) {
  const cookie = cookieValue(request.headers.get("cookie") || "", VISUALIZER_COOKIE);
  if (!cookie || !cookie.includes(".")) return false;
  const [payload, signature] = cookie.split(".", 2);
  const expected = await hmacSign(payload, visualizerSessionSecret(env));
  if (!constantTimeStringEqual(signature, expected)) return false;

  const decoded = parseMaybeJson(base64UrlDecode(payload));
  const exp = Number(decoded?.exp);
  return Number.isFinite(exp) && exp > Math.floor(Date.now() / 1000);
}

function visualizerSessionSecret(env) {
  return (
    env.VISUALIZER_SESSION_SECRET ||
    env.VISUALIZER_PASSWORD ||
    env.COMMAND_BRIDGE_TOKEN ||
    env.CLI_BRIDGE_TOKEN ||
    "phoneclaw-visualizer-dev"
  );
}

async function hmacSign(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function constantTimeStringEqual(left, right) {
  const leftText = String(left || "");
  const rightText = String(right || "");
  const max = Math.max(leftText.length, rightText.length);
  let diff = leftText.length ^ rightText.length;
  for (let index = 0; index < max; index += 1) {
    diff |= (leftText.charCodeAt(index) || 0) ^ (rightText.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function cookieValue(cookieHeader, name) {
  return cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1) || "";
}

function isVisualizerHost(url) {
  return VISUALIZER_HOSTS.has(url.hostname.toLowerCase());
}

function redirectNoCookie(location) {
  return new Response("", {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
    },
  });
}

function redirectWithCookie(location, cookie) {
  return new Response("", {
    status: 302,
    headers: {
      location,
      "set-cookie": cookie,
      "cache-control": "no-store",
    },
  });
}

function visualizerLoginPage(message = "") {
  return new Response(visualizerLoginHtml(message), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function visualizerLoginHtml(message) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Phoneclaw Login</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1d2430; background: #f6f7f9; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 18px; }
    main { width: min(100%, 380px); border: 1px solid #d9dee7; background: #fff; border-radius: 8px; padding: 22px; }
    h1 { margin: 0 0 6px; font-size: 1.2rem; letter-spacing: 0; }
    p { margin: 0 0 18px; color: #6a7483; line-height: 1.45; }
    label { display: block; font-weight: 800; margin-bottom: 8px; }
    input { width: 100%; min-height: 40px; border: 1px solid #c9d1dd; border-radius: 6px; padding: 0 10px; font: inherit; }
    button { width: 100%; min-height: 40px; margin-top: 12px; border: 0; border-radius: 6px; background: #176b87; color: #fff; font: inherit; font-weight: 800; cursor: pointer; }
    .message { border: 1px solid #f1b4b4; background: #fff0f0; color: #8a1f1f; border-radius: 6px; padding: 9px 10px; margin-bottom: 12px; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>Phoneclaw Live</h1>
    <p>Enter the visualizer password to view live transcripts, tool calls, and call events.</p>
    ${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}
    <form method="post" action="/visualizer/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
      <button type="submit">Open visualizer</button>
    </form>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return atob(padded);
}

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
