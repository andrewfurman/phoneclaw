import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import { basicWebSearch } from "../shared/basic-web-search.mjs";
import { githubCliCat, githubCliLs } from "../shared/github-cli-tools.mjs";
import { githubSummary } from "../shared/github-summary.mjs";
import {
  isAllowedCaller,
  lastFourDigits,
  parseAllowedCallerNumbers,
} from "../shared/phone-numbers.mjs";
import { ELEVENLABS_TELEPHONY_AUDIO_FORMAT } from "../shared/telephony-audio-format.mjs";

const { validateRequest } = twilio;

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "127.0.0.1";
const elevenLabsApiBase =
  process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const elevenLabsAgentId = process.env.ELEVENLABS_AGENT_ID;
const commandBridgeToken = process.env.COMMAND_BRIDGE_TOKEN;
const webSearchToken = process.env.WEB_SEARCH_TOKEN || commandBridgeToken;
const githubReadToken = process.env.GITHUB_READ_TOKEN;
const claudeBridgeUrl = process.env.CLAUDE_BRIDGE_URL;
const claudeBridgeToken = process.env.CLAUDE_BRIDGE_TOKEN;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const enforceTwilioSignature =
  process.env.ENFORCE_TWILIO_SIGNATURE === "true" && Boolean(twilioAuthToken);
const outsideCoverageMessage =
  process.env.OUTSIDE_COVERAGE_MESSAGE ||
  "Thanks for calling Andrew's assistance line. Sorry we haven't set up outside coverage yet.";

const app = Fastify({
  logger: true,
  trustProxy: true,
  bodyLimit: 1_000_000,
});

await app.register(formbody);

app.get("/", async () => ({
  ok: true,
  endpoints: {
    twilio_inbound: "POST /twilio/inbound",
    twilio_outbound: "POST /twilio/outbound",
    web_search: "POST /web-search",
    github_summary: "POST /github-summary",
    github_cli_ls: "POST /github-cli/ls",
    github_cli_cat: "POST /github-cli/cat",
    future_claude_tool: "POST /agent-command",
    health: "GET /health",
  },
}));

app.get("/health", async () => ({
  ok: true,
  elevenlabs_agent_configured: Boolean(elevenLabsAgentId),
  command_bridge_configured: Boolean(claudeBridgeUrl),
  web_search_configured: Boolean(webSearchToken),
  github_read_configured: Boolean(githubReadToken),
  expected_elevenlabs_audio_format: ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
  allowed_caller_numbers_configured:
    parseAllowedCallerNumbers(process.env.ALLOWED_CALLER_NUMBERS).length > 0,
  twilio_signature_enforced: enforceTwilioSignature,
}));

app.post("/twilio/inbound", async (request, reply) =>
  handleTwilioCall(request, reply, "inbound")
);

app.post("/twilio/outbound", async (request, reply) =>
  handleTwilioCall(request, reply, "outbound")
);

app.post("/agent-command", async (request, reply) => handleAgentCommand(request, reply));

app.post("/web-search", async (request, reply) => handleWebSearch(request, reply));

app.post("/github-summary", async (request, reply) =>
  handleGithubSummary(request, reply)
);

app.post("/github-cli/ls", async (request, reply) => handleGithubCliLs(request, reply));

app.post("/github-cli/cat", async (request, reply) =>
  handleGithubCliCat(request, reply)
);

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

  return extractTwiml(text, contentType);
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

  const result = await basicWebSearch({ query, maxResults });
  return reply.code(result.ok ? 200 : 400).send(result);
}

async function handleGithubSummary(request, reply) {
  if (!validateToolAuth(request, reply)) return;

  try {
    const body = request.body || {};
    const result = await githubSummary({
      githubToken: githubReadToken,
      username: process.env.GITHUB_USERNAME,
      itemType: body.item_type || body.itemType || body.type || body.kind,
      scope: body.scope,
      maxResults: body.max_results || body.maxResults || 5,
      repo: body.repo || body.repository,
      owner: body.owner,
      organization: body.organization || body.org,
    });

    return reply.code(result.ok ? 200 : 400).send(result);
  } catch (error) {
    return reply.code(400).send(githubToolError(error));
  }
}

async function handleGithubCliLs(request, reply) {
  if (!validateToolAuth(request, reply)) return;

  try {
    const body = request.body || {};
    const result = await githubCliLs({
      githubToken: githubReadToken,
      repo: body.repo || body.repository,
      path: body.path || "",
      ref: body.ref || body.branch || body.sha,
      recursive: body.recursive,
      maxEntries: body.max_entries || body.maxEntries,
    });

    return reply.code(result.ok ? 200 : 400).send(result);
  } catch (error) {
    return reply.code(400).send(githubToolError(error));
  }
}

async function handleGithubCliCat(request, reply) {
  if (!validateToolAuth(request, reply)) return;

  try {
    const body = request.body || {};
    const result = await githubCliCat({
      githubToken: githubReadToken,
      repo: body.repo || body.repository,
      path: body.path,
      ref: body.ref || body.branch || body.sha,
      maxBytes: body.max_bytes || body.maxBytes,
    });

    return reply.code(result.ok ? 200 : 400).send(result);
  } catch (error) {
    return reply.code(400).send(githubToolError(error));
  }
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

function publicRequestUrl(request) {
  const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const proto = forwardedProto || request.protocol || "https";
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const hostHeader = forwardedHost || request.headers.host;
  return `${proto}://${hostHeader}${request.url}`;
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
