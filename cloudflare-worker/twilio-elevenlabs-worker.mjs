import {
  ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
} from "../shared/telephony-audio-format.mjs";
import { basicWebSearch } from "../shared/basic-web-search.mjs";
import {
  isAllowedCaller,
  lastFourDigits,
  parseAllowedCallerNumbers,
} from "../shared/phone-numbers.mjs";

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
        expected_elevenlabs_audio_format:
          env.ELEVENLABS_TELEPHONY_AUDIO_FORMAT || ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
        allowed_caller_numbers_configured: parseAllowedCallerNumbers(
          env.ALLOWED_CALLER_NUMBERS
        ).length > 0,
        twilio_webhook_token_required: Boolean(env.TWILIO_WEBHOOK_TOKEN),
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        endpoints: {
          twilio_inbound: "POST /twilio/inbound",
          twilio_outbound: "POST /twilio/outbound",
          web_search: "POST /web-search",
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

    if (request.method === "POST" && url.pathname === "/agent-command") {
      return handleAgentCommand(request, env);
    }

    if (request.method === "POST" && url.pathname === "/web-search") {
      return handleWebSearch(request, env);
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

    const twiml = await registerElevenLabsTwilioCall(env, {
      direction,
      fromNumber,
      toNumber,
      callSid: body.CallSid,
    });

    return xml(twiml);
  } catch (error) {
    console.error(error);
    return xml(sayTwiml("The voice agent connection failed. Please try again later."));
  }
}

async function registerElevenLabsTwilioCall(
  env,
  { direction, fromNumber, toNumber, callSid }
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

  return extractTwiml(text, contentType);
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
  const webSearchToken = env.WEB_SEARCH_TOKEN || env.COMMAND_BRIDGE_TOKEN;
  if (!webSearchToken) {
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
  if (authHeader !== `Bearer ${webSearchToken}`) {
    return json({ ok: false, status: "unauthorized" }, 401);
  }

  const body = await parseRequestBody(request);
  const query = body.query || body.search_query || body.searchQuery;
  const maxResults = body.max_results || body.maxResults || 5;

  const result = await basicWebSearch({ query, maxResults });
  return json(result, result.ok ? 200 : 400);
}

function isValidTwilioWebhookRequest(request, env) {
  if (!env.TWILIO_WEBHOOK_TOKEN) return true;
  const url = new URL(request.url);
  return url.searchParams.get("token") === env.TWILIO_WEBHOOK_TOKEN;
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
