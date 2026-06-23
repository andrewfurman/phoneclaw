const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;
const forwardTo = process.env.EMAIL_DRAFT_TEST_TO || "aifurman@gmail.com";
const folder = process.env.EMAIL_DRAFT_TEST_FOLDER || "INBOX";

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

const selected = await findNewsletterLikeEmail();
const forwardResult = await createForwardDraft(selected);
const replyAllResult = await createReplyAllDraft(selected);

const checks = {
  selected_email_has_id: Boolean(selected.id),
  forward_draft_created:
    forwardResult.ok === true && forwardResult.action === "forward_draft_created",
  forward_to_self: String(forwardResult.to || "").toLowerCase().includes(forwardTo.toLowerCase()),
  forward_preserved_html_or_plain:
    forwardResult.original_has_html === true || forwardResult.original_has_plain === true,
  forward_no_eml_attachment: forwardResult.attached_original_eml === false,
  reply_all_draft_created:
    replyAllResult.ok === true && replyAllResult.action === "reply_all_draft_created",
  reply_all_flagged: replyAllResult.reply_all === true,
  reply_all_preserved_html_or_plain:
    replyAllResult.original_has_html === true || replyAllResult.original_has_plain === true,
  reply_all_no_eml_attachment: replyAllResult.attached_original_eml === false,
};

const ok = Object.values(checks).every(Boolean);

console.log(
  JSON.stringify(
    {
      ok,
      selected_email: {
        id: selected.id,
        subject: selected.subject || "",
        from: selected.from || "",
        date: selected.date || "",
      },
      forward_result: summarizeDraftResult(forwardResult),
      reply_all_result: summarizeDraftResult(replyAllResult),
      checks,
    },
    null,
    2
  )
);

process.exit(ok ? 0 : 1);

async function findNewsletterLikeEmail() {
  const inbox = await bridgeJson("/cli/himalaya/email-list", {
    folder,
    page_size: 20,
  });

  const items = Array.isArray(inbox.items) ? inbox.items : [];
  if (!inbox.ok || items.length === 0) {
    throw new Error(`Could not list ${folder}: ${JSON.stringify(summarizeDraftResult(inbox))}`);
  }

  return (
    items.find((item) => looksLikeNewsletter(`${item.from || ""} ${item.subject || ""}`)) ||
    items[0]
  );
}

async function createForwardDraft(selected) {
  return bridgeJson("/cli/himalaya/create-forward-draft", {
    id: selected.id,
    folder,
    to: forwardTo,
    body: [
      "Andrew,",
      "",
      "Here is a Phoneclaw validation forward draft. I picked this recent newsletter so you can inspect whether Gmail shows the original HTML inline below this note.",
      "",
      "This draft was created automatically and was not sent.",
    ].join("\n"),
    confirmed: true,
  });
}

async function createReplyAllDraft(selected) {
  return bridgeJson("/cli/himalaya/create-reply-all-draft", {
    id: selected.id,
    folder,
    body: [
      "Phoneclaw validation reply-all draft only.",
      "",
      "This is checking that the agent can create a reply-all draft with my text above the quoted original thread. Please do not send this draft.",
    ].join("\n"),
    confirmed: true,
  });
}

async function bridgeJson(path, body) {
  const response = await fetch(`${workerBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${toolToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = parseMaybeJson(text);

  if (!response.ok) {
    throw new Error(`Bridge request ${path} failed (${response.status}): ${JSON.stringify(parsed)}`);
  }

  return parsed;
}

function looksLikeNewsletter(value) {
  return /\b(newsletter|digest|brief|daily|weekly|roundup|update|news|morning|substack|economist|axios|semafor|stratechery|notion|product)\b/i.test(
    value
  );
}

function summarizeDraftResult(result) {
  return {
    ok: result?.ok,
    status: result?.status,
    action: result?.action,
    id: result?.id,
    draft_id: result?.draft_id,
    to: result?.to,
    subject: result?.subject,
    reply_all: result?.reply_all,
    original_has_html: result?.original_has_html,
    original_has_plain: result?.original_has_plain,
    attached_original_eml: result?.attached_original_eml,
    answer_text: result?.answer_text,
  };
}

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
