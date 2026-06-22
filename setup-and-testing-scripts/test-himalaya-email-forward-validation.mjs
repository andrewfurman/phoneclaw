const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

const response = await fetch(`${workerBaseUrl}/cli/himalaya/email-forward`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${toolToken}`,
  },
  body: JSON.stringify({
    id: "validation-only",
    folder: "INBOX",
    to: "not-an-email",
    body: "This should not create a draft.",
    confirmed: true,
  }),
});
const text = await response.text();
const body = parseMaybeJson(text);

const ok =
  response.status === 400 &&
  body?.status === "missing_field" &&
  body?.field === "to";

console.log(
  JSON.stringify(
    {
      ok,
      status: response.status,
      body_status: body?.status || "",
      field: body?.field || "",
      answer_text: body?.answer_text || "",
    },
    null,
    2
  )
);

process.exit(ok ? 0 : 1);

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
