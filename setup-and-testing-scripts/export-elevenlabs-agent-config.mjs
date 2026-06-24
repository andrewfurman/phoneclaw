import { writeFile } from "node:fs/promises";

const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const outputPath =
  process.env.ELEVENLABS_AGENT_CONFIG_OUTPUT ||
  "elevenlabs-setup/andrew-assistant-agent.config.json";

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

const agent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`);
const toolIds = agent.conversation_config?.agent?.prompt?.tool_ids || [];
const tools = [];
for (const toolId of toolIds) {
  tools.push(await requestJson(`${apiBase}/v1/convai/tools/${toolId}`));
}

const snapshot = redact({
  exported_at: new Date().toISOString(),
  source: "ElevenLabs API: GET /v1/convai/agents/:agent_id and /v1/convai/tools/:tool_id",
  redaction_note:
    "access_info, phone_numbers, whatsapp_accounts, auth headers, secret-like strings, and phone numbers are redacted or omitted recursively.",
  observed_dashboard_changes: {
    voice: {
      voice_id: agent.conversation_config?.tts?.voice_id || null,
    },
    llm: agent.conversation_config?.agent?.prompt?.llm || null,
    tools: tools.map((tool) => ({
      tool_id: tool.id,
      name: tool.tool_config?.name,
      url: tool.tool_config?.api_schema?.url,
      method: tool.tool_config?.api_schema?.method,
      auth: tool.tool_config?.api_schema?.request_headers?.Authorization
        ? "[redacted]"
        : null,
      response_fields: Object.keys(
        tool.tool_config?.api_schema?.response_body_schema?.properties || {}
      ),
    })),
    system_tools: Object.keys(
      agent.conversation_config?.agent?.prompt?.built_in_tools || {}
    ),
  },
  agent,
  tools,
});

await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, output_path: outputPath, tool_count: tools.length }));

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

function redact(value, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (!value || typeof value !== "object") {
    return redactScalar(value, key);
  }

  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (shouldOmitKey(childKey)) continue;
    result[childKey] = redact(childValue, childKey);
  }
  return result;
}

function redactScalar(value, key) {
  if (typeof value !== "string") return value;

  if (shouldRedactKey(key)) return "[redacted]";

  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/gh[opsru]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/sk_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/\+1\d{10}\b/g, "[redacted-phone]")
    .replace(/\b\d{3}[-.]\d{3}[-.]\d{4}\b/g, "[redacted-phone]");
}

function shouldOmitKey(key) {
  return new Set(["access_info", "phone_numbers", "whatsapp_accounts"]).has(key);
}

function shouldRedactKey(key) {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("authorization") ||
    normalized.includes("api_key") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("phone_number")
  );
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
