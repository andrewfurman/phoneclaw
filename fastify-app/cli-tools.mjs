import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { htmlToText } from "html-to-text";

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_BUFFER_BYTES = 1_000_000;
const DEFAULT_MAX_RAW_BYTES = 200_000;
const MAX_RAW_BYTES = 750_000;
const MAX_LIST_RESULTS = 50;
const MAX_EMAIL_LIST_PAGES = 200;
const DEFAULT_EMAIL_LIST_MAX_ITEMS = 200;
const MAX_EMAIL_LIST_ITEMS = 1_000;
const DEFAULT_HIMALAYA_SEND_TIMEOUT_MS = 8_000;
const DEFAULT_FORWARD_MAX_ORIGINAL_BYTES = 600_000;
const MAX_FORWARD_ORIGINAL_BYTES = 1_500_000;
const MAX_CLI_ARGUMENT_BYTES = 60_000;

export async function himalayaEmailList({
  query = "",
  folder = "INBOX",
  account,
  page = 1,
  pageSize = 10,
  allPages = false,
  maxPages = MAX_EMAIL_LIST_PAGES,
  maxItems = DEFAULT_EMAIL_LIST_MAX_ITEMS,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const normalizedFolder = normalizeString(folder, "INBOX");
  const normalizedQuery = normalizeString(query);
  const shouldFetchAllPages = toBoolean(allPages);
  const normalizedPage = clampInteger(page, 1, 100, 1);
  const normalizedPageSize = clampInteger(
    pageSize,
    1,
    MAX_LIST_RESULTS,
    shouldFetchAllPages ? MAX_LIST_RESULTS : 10
  );
  const normalizedMaxPages = clampInteger(maxPages, 1, MAX_EMAIL_LIST_PAGES, MAX_EMAIL_LIST_PAGES);
  const normalizedMaxItems = clampInteger(
    maxItems,
    1,
    MAX_EMAIL_LIST_ITEMS,
    DEFAULT_EMAIL_LIST_MAX_ITEMS
  );

  if (shouldFetchAllPages) {
    return himalayaEmailListAllPages({
      query: normalizedQuery,
      folder: normalizedFolder,
      account,
      pageSize: normalizedPageSize,
      maxPages: normalizedMaxPages,
      maxItems: normalizedMaxItems,
      maxRawBytes,
    });
  }

  const result = await runHimalayaEnvelopeListPage({
    query: normalizedQuery,
    folder: normalizedFolder,
    account,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    maxRawBytes,
  });

  const envelopes = Array.isArray(result.parsed_json)
    ? result.parsed_json.map(compactEnvelope)
    : [];
  const exact = normalizedPage === 1 && envelopes.length < normalizedPageSize;

  return {
    ...compactCliResult(result),
    command: "himalaya envelope list",
    folder: normalizedFolder,
    query: normalizedQuery,
    all_pages: false,
    page: normalizedPage,
    page_size: normalizedPageSize,
    returned_count: envelopes.length,
    total_count: exact ? envelopes.length : null,
    pages_scanned: 1,
    max_items: null,
    has_more: exact ? false : null,
    complete: exact,
    exact,
    capped: false,
    items: envelopes,
    answer_text: result.ok
      ? formatEmailListAnswer(envelopes, normalizedFolder, {
          page: normalizedPage,
          pageSize: normalizedPageSize,
          allPages: false,
          exact,
        })
      : result.answer_text,
  };
}

export async function himalayaEmailRead({
  id,
  folder = "INBOX",
  account,
  includeHeaders = true,
  markSeen = false,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const messageId = normalizeString(id);
  if (!messageId) {
    return missingField("id", "A Himalaya envelope id is required.");
  }

  const args = [
    "-o",
    "json",
    "message",
    "read",
    "--folder",
    normalizeString(folder, "INBOX"),
  ];

  if (!toBoolean(markSeen)) args.push("--preview");
  if (!toBoolean(includeHeaders, true)) args.push("--no-headers");
  if (account) args.push("--account", normalizeString(account));
  args.push(messageId);

  const result = await runCli({
    command: process.env.HIMALAYA_BIN || "himalaya",
    args,
    maxRawBytes,
  });

  return {
    ...result,
    command: "himalaya message read",
    folder: normalizeString(folder, "INBOX"),
    id: messageId,
    answer_text: result.ok
      ? "I found that email message. Use the raw output to summarize the headers and body."
      : result.answer_text,
  };
}

export async function himalayaEmailArchive({
  id,
  ids,
  folder = "INBOX",
  archiveFolder = process.env.HIMALAYA_ARCHIVE_FOLDER || "[Gmail]/All Mail",
  account,
  confirmed = false,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const messageIds = normalizeIdList(ids, id);
  const sourceFolder = normalizeString(folder, "INBOX");
  const targetFolder = normalizeString(archiveFolder, "[Gmail]/All Mail");

  if (messageIds.length === 0) {
    return missingField("id", "A Himalaya envelope id is required.");
  }

  if (!toBoolean(confirmed)) {
    const countText =
      messageIds.length === 1 ? "the selected email" : `${messageIds.length} selected emails`;
    return confirmationRequired(
      `Confirm that Andrew wants to archive ${countText} from ${sourceFolder} to ${targetFolder}.`
    );
  }

  const results = [];
  for (const messageId of messageIds) {
    const args = [
      "-o",
      "json",
      "message",
      "move",
      "--folder",
      sourceFolder,
    ];
    if (account) args.push("--account", normalizeString(account));
    args.push(targetFolder, messageId);

    const result = await runCli({
      command: process.env.HIMALAYA_BIN || "himalaya",
      args,
      maxRawBytes,
    });

    results.push({
      id: messageId,
      ok: result.ok,
      status: result.status,
      exit_code: result.exit_code,
      answer_text: result.answer_text,
    });
  }

  const archivedCount = results.filter((result) => result.ok).length;
  const failedCount = results.length - archivedCount;
  const allArchived = failedCount === 0;

  return {
    ok: allArchived,
    status: allArchived ? "ok" : "email_archive_partial_failure",
    command: "himalaya message move",
    action: allArchived ? "archived" : "archive_partial_failure",
    id: messageIds[0],
    ids: messageIds,
    archived_count: archivedCount,
    failed_count: failedCount,
    results,
    source_folder: sourceFolder,
    target_folder: targetFolder,
    answer_text: allArchived
      ? `Archived ${archivedCount === 1 ? "the selected email" : `${archivedCount} selected emails`}.`
      : `Archived ${archivedCount} of ${messageIds.length} selected emails. ${failedCount} failed.`,
  };
}

export async function himalayaDraftCreate({
  to,
  cc,
  bcc,
  subject,
  body,
  draftFolder = process.env.HIMALAYA_DRAFTS_FOLDER || "[Gmail]/Drafts",
  account,
  confirmed = false,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const normalizedTo = normalizeHeaderValue(to);
  const normalizedSubject = normalizeHeaderValue(subject);
  const normalizedBody = normalizeString(body);
  const normalizedDraftFolder = normalizeString(draftFolder, "[Gmail]/Drafts");

  if (!normalizedTo) {
    return missingField("to", "At least one recipient is required for a draft.");
  }
  if (!normalizedSubject) {
    return missingField("subject", "A subject is required for a draft.");
  }

  if (!toBoolean(confirmed)) {
    return confirmationRequired(
      `Confirm that Andrew wants to save a draft to ${normalizedTo} with subject "${normalizedSubject}".`
    );
  }

  const fromAddress = await getHimalayaFromAddress({ account, maxRawBytes });
  if (!fromAddress.ok) return fromAddress;

  const saved = await saveRawHimalayaMessage({
    rawMessage: buildRawEmailMessage({
      from: fromAddress.from,
      to: normalizedTo,
      cc: normalizeHeaderValue(cc),
      bcc: normalizeHeaderValue(bcc),
      subject: normalizedSubject,
      body: normalizedBody,
    }),
    draftFolder: normalizedDraftFolder,
    account,
    maxRawBytes,
  });

  return {
    ...saved,
    command: "himalaya message save",
    action: "draft_created",
    draft_id: savedHimalayaMessageId(saved),
    draft_folder: normalizedDraftFolder,
    to: normalizedTo,
    subject: normalizedSubject,
    answer_text: saved.ok
      ? `Saved a draft email to ${normalizedTo} with subject "${normalizedSubject}".`
      : saved.answer_text,
  };
}

export async function himalayaDraftReply({
  id,
  folder = "INBOX",
  body,
  replyAll = false,
  includeOriginalThread = false,
  draftFolder = process.env.HIMALAYA_DRAFTS_FOLDER || "[Gmail]/Drafts",
  account,
  confirmed = false,
  maxOriginalBytes = DEFAULT_FORWARD_MAX_ORIGINAL_BYTES,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const messageId = normalizeString(id);
  const sourceFolder = normalizeString(folder, "INBOX");
  const normalizedDraftFolder = normalizeString(draftFolder, "[Gmail]/Drafts");
  const normalizedBody = normalizeString(body);
  const shouldReplyAll = toBoolean(replyAll);
  const shouldIncludeOriginalThread = toBoolean(includeOriginalThread);
  const boundedMaxOriginalBytes = clampInteger(
    maxOriginalBytes,
    10_000,
    MAX_FORWARD_ORIGINAL_BYTES,
    DEFAULT_FORWARD_MAX_ORIGINAL_BYTES
  );

  if (!messageId) {
    return missingField("id", "A Himalaya envelope id is required.");
  }

  if (!toBoolean(confirmed)) {
    return confirmationRequired(
      `Confirm that Andrew wants to save a ${shouldReplyAll ? "reply-all" : "reply"} draft for the selected email.`
    );
  }

  const original = await himalayaEmailRead({
    id: messageId,
    folder: sourceFolder,
    account,
    includeHeaders: true,
    markSeen: false,
    maxRawBytes,
  });
  if (!original.ok) return original;

  const originalHeaders = parseEmailHeaders(original.parsed_json || original.raw_json || "");
  const replyTemplate = await buildHimalayaTemplate({
    mode: "reply",
    id: messageId,
    folder: sourceFolder,
    replyAll: shouldReplyAll,
    account,
    maxRawBytes,
  });
  if (!replyTemplate.ok) return replyTemplate;

  const replyHeaders = parseEmailHeaders(replyTemplate.raw_json);
  let replyFrom = headerValue(replyHeaders, "from");
  if (!replyFrom) {
    const fromAddress = await getHimalayaFromAddress({ account, maxRawBytes });
    if (!fromAddress.ok) return fromAddress;
    replyFrom = fromAddress.from;
  }
  const replyTo =
    headerValue(replyHeaders, "to") ||
    headerValue(originalHeaders, "reply-to") ||
    headerValue(originalHeaders, "from");
  const replyCc = headerValue(replyHeaders, "cc");
  const replySubject =
    headerValue(replyHeaders, "subject") ||
    ensureReplySubject(headerValue(originalHeaders, "subject"));

  if (!replyTo) {
    return {
      ok: false,
      status: "missing_reply_recipient",
      message: "Could not determine a recipient for the reply draft.",
      answer_text: "I could not determine a recipient for that reply draft.",
    };
  }

  let parsedOriginal = null;
  if (shouldIncludeOriginalThread) {
    const originalExport = await exportHimalayaRawMessage({
      id: messageId,
      folder: sourceFolder,
      account,
      maxOriginalBytes: boundedMaxOriginalBytes,
      maxRawBytes,
    });
    if (!originalExport.ok) return originalExport;
    parsedOriginal = parseForwardOriginal(originalExport.raw_message_buffer);
  }

  const saved = await saveRawHimalayaMessage({
    rawMessage: parsedOriginal
      ? buildReplyRawEmailMessage({
          from: replyFrom,
          to: replyTo,
          cc: replyCc,
          subject: replySubject,
          body: normalizedBody,
          inReplyTo: headerValue(replyHeaders, "in-reply-to"),
          references:
            headerValue(replyHeaders, "references") || headerValue(replyHeaders, "in-reply-to"),
          original: parsedOriginal,
        })
      : buildRawEmailMessage({
          from: replyFrom,
          to: replyTo,
          cc: replyCc,
          subject: replySubject,
          body: normalizedBody,
          inReplyTo: headerValue(replyHeaders, "in-reply-to"),
          references:
            headerValue(replyHeaders, "references") || headerValue(replyHeaders, "in-reply-to"),
        }),
    draftFolder: normalizedDraftFolder,
    account,
    maxRawBytes,
  });

  return {
    ...saved,
    command: "himalaya message save",
    action: shouldReplyAll ? "reply_all_draft_created" : "reply_draft_created",
    draft_id: savedHimalayaMessageId(saved),
    id: messageId,
    source_folder: sourceFolder,
    draft_folder: normalizedDraftFolder,
    reply_all: shouldReplyAll,
    original_has_html: Boolean(parsedOriginal?.html),
    original_has_plain: Boolean(parsedOriginal?.plain),
    attached_original_eml: false,
    answer_text: saved.ok
      ? `Saved a ${shouldReplyAll ? "reply-all" : "reply"} draft for the selected email.`
      : saved.answer_text,
  };
}

export async function himalayaCreateReplyAllDraft({
  id,
  folder = "INBOX",
  body,
  message,
  draftFolder = process.env.HIMALAYA_DRAFTS_FOLDER || "[Gmail]/Drafts",
  account,
  confirmed = false,
  maxOriginalBytes = DEFAULT_FORWARD_MAX_ORIGINAL_BYTES,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  return himalayaDraftReply({
    id,
    folder,
    body: body || message,
    replyAll: true,
    includeOriginalThread: true,
    draftFolder,
    account,
    confirmed,
    maxOriginalBytes,
    maxRawBytes,
  });
}

export async function himalayaEmailForward({
  id,
  folder = "INBOX",
  to,
  cc,
  bcc,
  subject,
  body,
  message,
  draftFolder = process.env.HIMALAYA_DRAFTS_FOLDER || "[Gmail]/Drafts",
  account,
  confirmed = false,
  maxOriginalBytes = DEFAULT_FORWARD_MAX_ORIGINAL_BYTES,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const messageId = normalizeString(id);
  const sourceFolder = normalizeString(folder, "INBOX");
  const normalizedTo = normalizeHeaderValue(to);
  const normalizedCc = normalizeHeaderValue(cc);
  const normalizedBcc = normalizeHeaderValue(bcc);
  const normalizedBody = normalizeString(body || message);
  const normalizedDraftFolder = normalizeString(draftFolder, "[Gmail]/Drafts");
  const boundedMaxOriginalBytes = clampInteger(
    maxOriginalBytes,
    10_000,
    MAX_FORWARD_ORIGINAL_BYTES,
    DEFAULT_FORWARD_MAX_ORIGINAL_BYTES
  );

  if (!messageId) {
    return missingField("id", "A Himalaya envelope id is required.");
  }
  if (!normalizedTo) {
    return missingField("to", "At least one forwarding recipient is required.");
  }
  if (!hasEmailAddress(normalizedTo)) {
    return missingField(
      "to",
      "The forwarding recipient must include at least one explicit email address."
    );
  }

  const preview = {
    id: messageId,
    source_folder: sourceFolder,
    to: normalizedTo,
    cc: normalizedCc,
    bcc: normalizedBcc,
    message: normalizedBody,
    draft_folder: normalizedDraftFolder,
  };

  if (!toBoolean(confirmed)) {
    return {
      ...confirmationRequired(
        `Confirm that Andrew wants to save a forward draft for email ${messageId} to ${normalizedTo}.`
      ),
      action: "email_forward_confirmation_required",
      requires_confirmation: true,
      preview,
    };
  }

  const fromAddress = await getHimalayaFromAddress({ account, maxRawBytes });
  if (!fromAddress.ok) return fromAddress;

  const original = await exportHimalayaRawMessage({
    id: messageId,
    folder: sourceFolder,
    account,
    maxOriginalBytes: boundedMaxOriginalBytes,
    maxRawBytes,
  });
  if (!original.ok) return original;

  const parsedOriginal = parseForwardOriginal(original.raw_message_buffer);
  const forwardSubject =
    normalizeHeaderValue(subject) ||
    ensureForwardSubject(decodedHeaderValue(headerValue(parsedOriginal.headers, "subject")));
  const rawMessage = buildForwardRawEmailMessage({
    from: fromAddress.from,
    to: normalizedTo,
    cc: normalizedCc,
    bcc: normalizedBcc,
    subject: forwardSubject,
    body: normalizedBody,
    original: parsedOriginal,
  });

  const saved = await saveRawHimalayaMessage({
    rawMessage,
    draftFolder: normalizedDraftFolder,
    account,
    maxRawBytes,
  });

  return {
    ...saved,
    command: "himalaya message save",
    action: "forward_draft_created",
    draft_id: savedHimalayaMessageId(saved),
    id: messageId,
    source_folder: sourceFolder,
    draft_folder: normalizedDraftFolder,
    to: normalizedTo,
    cc: normalizedCc,
    bcc: normalizedBcc,
    subject: forwardSubject,
    original_has_html: Boolean(parsedOriginal.html),
    original_has_plain: Boolean(parsedOriginal.plain),
    original_size_bytes: original.size_bytes,
    attached_original_eml: false,
    answer_text: saved.ok
      ? `Saved a forward draft to ${normalizedTo} with subject "${forwardSubject}".`
      : saved.answer_text,
  };
}

export async function himalayaCreateForwardDraft(options = {}) {
  return himalayaEmailForward(options);
}

export async function himalayaEmailSend({
  to,
  cc,
  bcc,
  subject,
  body,
  account,
  emergency = false,
  previewed = false,
  confirmed = false,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const normalizedTo = normalizeHeaderValue(to);
  const normalizedCc = normalizeHeaderValue(cc);
  const normalizedBcc = normalizeHeaderValue(bcc);
  const normalizedSubject = normalizeHeaderValue(subject);
  const normalizedBody = normalizeString(body);
  const preview = {
    to: normalizedTo,
    cc: normalizedCc,
    bcc: normalizedBcc,
    subject: normalizedSubject,
    body: normalizedBody,
  };

  if (!normalizedTo) {
    return missingField("to", "At least one recipient is required before sending email.");
  }
  if (!hasEmailAddress(normalizedTo)) {
    return missingField(
      "to",
      "The recipient must include at least one explicit email address before sending."
    );
  }
  if (!normalizedSubject) {
    return missingField("subject", "A subject is required before sending email.");
  }
  if (!normalizedBody) {
    return missingField("body", "A non-empty email body is required before sending email.");
  }

  if (!toBoolean(emergency)) {
    return {
      ...confirmationRequired(
        "This send tool is emergency-only. Use the draft tools by default unless Andrew explicitly says this is an emergency send."
      ),
      action: "email_send_blocked_not_emergency",
      requires_emergency: true,
      preview,
    };
  }

  if (!toBoolean(previewed)) {
    return {
      ...confirmationRequired(
        `Before sending, read Andrew the exact email preview: To ${normalizedTo}; Subject "${normalizedSubject}"; Body "${normalizedBody}". Then ask, "Is this an emergency email, and do you want me to send it now?"`
      ),
      action: "email_send_preview_required",
      requires_preview: true,
      requires_confirmation: true,
      preview,
    };
  }

  if (!toBoolean(confirmed)) {
    return {
      ...confirmationRequired(
        `Confirm one more time that Andrew wants to send this emergency email now to ${normalizedTo} with subject "${normalizedSubject}".`
      ),
      action: "email_send_confirmation_required",
      requires_confirmation: true,
      preview,
    };
  }

  const fromAddress = await getHimalayaFromAddress({ account, maxRawBytes });
  if (!fromAddress.ok) return fromAddress;

  const sent = await sendRawHimalayaMessage({
    rawMessage: buildRawEmailMessage({
      from: fromAddress.from,
      to: normalizedTo,
      cc: normalizedCc,
      bcc: normalizedBcc,
      subject: normalizedSubject,
      body: normalizedBody,
    }),
    account,
    maxRawBytes,
  });

  const action = sent.ok
    ? "email_sent"
    : sent.status === "cli_timeout"
      ? "email_send_timeout"
      : "email_send_failed";

  return {
    ...sent,
    command: "himalaya message send",
    action,
    emergency: true,
    to: normalizedTo,
    cc: normalizedCc,
    bcc: normalizedBcc,
    subject: normalizedSubject,
    answer_text: emailSendAnswerText(sent, {
      to: normalizedTo,
      subject: normalizedSubject,
    }),
  };
}

export async function otterSpeechesList({
  source = "owned",
  days,
  pageSize = 10,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const normalizedSource = normalizeEnum(source, ["owned", "shared", "all"], "owned");
  const args = [
    "speeches",
    "list",
    "--json",
    "--page-size",
    String(clampInteger(pageSize, 1, MAX_LIST_RESULTS, 10)),
    "--source",
    normalizedSource,
  ];

  const dayLimit = days === undefined || days === null || days === ""
    ? null
    : clampInteger(days, 1, 3650, 30);
  if (dayLimit) args.push("--days", String(dayLimit));

  const result = await runCli({
    command: process.env.OTTER_BIN || "otter",
    args,
    maxRawBytes,
  });

  const speeches = Array.isArray(result.parsed_json?.speeches)
    ? result.parsed_json.speeches.map(compactOtterSpeech)
    : [];

  return {
    ...result,
    command: "otter speeches list",
    source: normalizedSource,
    days: dayLimit,
    returned_count: speeches.length,
    items: speeches,
    answer_text: result.ok
      ? formatOtterListAnswer(speeches)
      : result.answer_text,
  };
}

export async function otterSpeechGet({
  speechId,
  id,
  maxRawBytes = 500_000,
} = {}) {
  const otid = normalizeString(speechId || id);
  if (!otid) {
    return missingField("speech_id", "An Otter speech otid is required.");
  }

  const result = await runCli({
    command: process.env.OTTER_BIN || "otter",
    args: ["speeches", "get", "--json", otid],
    timeoutMs: 45_000,
    maxRawBytes,
  });

  const speech = compactOtterSpeech(result.parsed_json?.speech || {});

  return {
    ...result,
    command: "otter speeches get",
    speech_id: otid,
    speech,
    answer_text: result.ok
      ? `I retrieved the raw Otter JSON for ${speech.title || otid}.`
      : result.answer_text,
  };
}

export async function otterSpeechSearch({
  speechId,
  id,
  query,
  speaker,
  size = 20,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const otid = normalizeString(speechId || id);
  const normalizedQuery = normalizeString(query);
  const normalizedSpeaker = normalizeString(speaker);
  if (!otid) {
    return missingField("speech_id", "An Otter speech otid is required.");
  }
  if (!normalizedQuery && !normalizedSpeaker) {
    return missingField("query", "A search query or speaker name is required.");
  }

  if (normalizedSpeaker) {
    const transcript = await otterSpeechGet({
      speechId: otid,
      maxRawBytes: Math.max(maxRawBytes, 500_000),
    });
    if (!transcript.ok) return transcript;

    const items = searchOtterTranscriptSegments(transcript.parsed_json, {
      query: normalizedQuery,
      speaker: normalizedSpeaker,
      size,
    });
    const raw = truncateUtf8(JSON.stringify({ items }, null, 2), maxRawBytes);

    return {
      ...transcript,
      command: "otter speeches search",
      speech_id: otid,
      query: normalizedQuery,
      speaker: normalizedSpeaker,
      returned_count: items.length,
      items,
      raw_json: raw.value,
      raw_truncated: raw.truncated,
      answer_text:
        items.length > 0
          ? `I found ${items.length} Otter transcript segments matching speaker ${normalizedSpeaker}.`
          : `I found no Otter transcript segments matching speaker ${normalizedSpeaker}.`,
    };
  }

  const result = await runCli({
    command: process.env.OTTER_BIN || "otter",
    args: [
      "speeches",
      "search",
      "--json",
      "--size",
      String(clampInteger(size, 1, 100, 20)),
      normalizedQuery,
      otid,
    ],
    maxRawBytes,
  });

  return {
    ...result,
    command: "otter speeches search",
    speech_id: otid,
    query: normalizedQuery,
    speaker: "",
    answer_text: result.ok
      ? "I searched that Otter transcript. Use the raw JSON results to answer."
      : result.answer_text,
  };
}

export async function githubCliCommon({
  action,
  repo,
  number,
  state = "open",
  query,
  limit = 10,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const normalizedAction = normalizeEnum(
    action,
    [
      "repo_view",
      "issue_list",
      "issue_view",
      "pr_list",
      "pr_view",
      "search_issues",
      "search_prs",
    ],
    ""
  );
  if (!normalizedAction) {
    return missingField(
      "action",
      "Use one of repo_view, issue_list, issue_view, pr_list, pr_view, search_issues, or search_prs."
    );
  }

  const args = githubArgsFor({
    action: normalizedAction,
    repo: normalizeString(repo),
    number,
    state,
    query: normalizeString(query),
    limit,
  });

  if (args.error) return args.error;

  const result = await runCli({
    command: process.env.GH_BIN || "gh",
    args: args.value,
    maxRawBytes,
  });

  return {
    ...result,
    command: "gh",
    action: normalizedAction,
    gh_equivalent: `gh ${args.value.map(shellWord).join(" ")}`,
    answer_text: result.ok
      ? formatGithubCliAnswer(normalizedAction, result.parsed_json)
      : result.answer_text,
  };
}

function githubArgsFor({ action, repo, number, state, query, limit }) {
  const boundedLimit = String(clampInteger(limit, 1, MAX_LIST_RESULTS, 10));
  const normalizedState = normalizeEnum(state, ["open", "closed", "all"], "open");
  const issueFields =
    "number,title,state,author,labels,assignees,comments,createdAt,updatedAt,url";
  const issueSearchFields =
    "number,title,state,author,labels,assignees,commentsCount,createdAt,updatedAt,url,repository";
  const issueViewFields = `${issueFields},body`;
  const prFields =
    "number,title,state,author,labels,assignees,createdAt,updatedAt,url,reviewDecision,isDraft";
  const prViewFields = `${prFields},body,mergeStateStatus,headRefName,baseRefName,files,comments,reviews`;
  const prSearchFields =
    "number,title,state,author,labels,assignees,commentsCount,createdAt,updatedAt,url,repository";

  if (["repo_view", "issue_list", "issue_view", "pr_list", "pr_view"].includes(action)) {
    if (!repo) return { error: missingField("repo", "A GitHub repo in owner/name format is required.") };
  }

  if (action === "repo_view") {
    return {
      value: [
        "repo",
        "view",
        repo,
        "--json",
        "nameWithOwner,description,defaultBranchRef,isPrivate,url,pushedAt,updatedAt",
      ],
    };
  }

  if (action === "issue_list") {
    return {
      value: [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        normalizedState,
        "--limit",
        boundedLimit,
        "--json",
        issueFields,
      ],
    };
  }

  if (action === "issue_view") {
    const issueNumber = normalizeIssueNumber(number);
    if (!issueNumber) return { error: missingField("number", "A GitHub issue number is required.") };
    return {
      value: ["issue", "view", issueNumber, "--repo", repo, "--json", issueViewFields],
    };
  }

  if (action === "pr_list") {
    return {
      value: [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        normalizedState,
        "--limit",
        boundedLimit,
        "--json",
        prFields,
      ],
    };
  }

  if (action === "pr_view") {
    const prNumber = normalizeIssueNumber(number);
    if (!prNumber) return { error: missingField("number", "A GitHub pull request number is required.") };
    return {
      value: ["pr", "view", prNumber, "--repo", repo, "--json", prViewFields],
    };
  }

  if (action === "search_issues" || action === "search_prs") {
    if (!query) return { error: missingField("query", "A GitHub search query is required.") };
    const queryArgs = splitSearchQuery(query);
    return {
      value: [
        "search",
        action === "search_prs" ? "prs" : "issues",
        ...queryArgs,
        "--limit",
        boundedLimit,
        "--json",
        action === "search_prs" ? prSearchFields : issueSearchFields,
      ],
    };
  }

  return { error: missingField("action", "Unsupported GitHub CLI action.") };
}

function runCli({ command, args, timeoutMs = DEFAULT_TIMEOUT_MS, maxRawBytes, input }) {
  const rawLimit = clampInteger(maxRawBytes, 1_000, MAX_RAW_BYTES, DEFAULT_MAX_RAW_BYTES);

  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        command,
        args,
        {
          env: {
            ...process.env,
            NO_COLOR: "1",
          },
          timeout: timeoutMs,
          maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const cleanStdout = redact(stdout || "");
          const cleanStderr = redact(stderr || "");
          const truncated = truncateUtf8(cleanStdout, rawLimit);
          const parsed = parseMaybeJson(cleanStdout);

          if (error) {
            resolve({
              ok: false,
              status: error.killed ? "cli_timeout" : "cli_failed",
              timeout_ms: timeoutMs,
              exit_code: typeof error.code === "number" ? error.code : null,
              signal: error.signal || null,
              message: cleanStderr.trim() || error.message || "CLI command failed.",
              raw_json: truncated.value,
              raw_truncated: truncated.truncated,
              stderr: truncateUtf8(cleanStderr, 10_000).value,
              parsed_json: parsed,
              answer_text:
                cleanStderr.trim() || error.message || "The CLI command failed.",
            });
            return;
          }

          resolve({
            ok: true,
            status: "ok",
            timeout_ms: timeoutMs,
            exit_code: 0,
            raw_json: truncated.value,
            raw_truncated: truncated.truncated,
            stderr: truncateUtf8(cleanStderr, 10_000).value,
            parsed_json: parsed,
            answer_text: "The CLI command completed successfully.",
          });
        }
      );
    } catch (error) {
      resolve({
        ok: false,
        status: "cli_spawn_failed",
        timeout_ms: timeoutMs,
        exit_code: null,
        signal: null,
        message: error?.message || "CLI command failed to start.",
        raw_json: "",
        raw_truncated: false,
        stderr: "",
        parsed_json: null,
        answer_text: error?.message || "The CLI command failed to start.",
      }
      );
      return;
    }

    if (input != null) {
      child.stdin?.end(input);
    }
  });
}

async function buildHimalayaTemplate({
  mode,
  id,
  folder,
  replyAll = false,
  headers = {},
  body = "",
  account,
  maxRawBytes,
}) {
  const args = ["template", mode];
  if (mode === "reply") {
    args.push("--folder", normalizeString(folder, "INBOX"));
    if (toBoolean(replyAll)) args.push("--all");
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    args.push("--header", `${key}:${value}`);
  }
  if (account) args.push("--account", normalizeString(account));
  if (mode === "reply") args.push(normalizeString(id));
  if (body) args.push(body);

  const result = await runCli({
    command: process.env.HIMALAYA_BIN || "himalaya",
    args,
    maxRawBytes,
  });

  if (!result.ok) {
    return {
      ...result,
      command: `himalaya template ${mode}`,
    };
  }

  return {
    ...result,
    command: `himalaya template ${mode}`,
    answer_text: "Generated an email draft template.",
  };
}

async function saveHimalayaTemplate({
  template,
  draftFolder,
  account,
  maxRawBytes,
}) {
  if (!template) {
    return {
      ok: false,
      status: "empty_template",
      message: "Himalaya did not return a template to save.",
      answer_text: "Himalaya did not return a template to save.",
    };
  }

  const args = [
    "template",
    "save",
    "--folder",
    normalizeString(draftFolder, "[Gmail]/Drafts"),
  ];
  if (account) args.push("--account", normalizeString(account));
  args.push(template);

  return runCli({
    command: process.env.HIMALAYA_BIN || "himalaya",
    args,
    timeoutMs: 35_000,
    maxRawBytes,
  });
}

async function getHimalayaFromAddress({ account, maxRawBytes }) {
  const configured = normalizeHeaderValue(process.env.HIMALAYA_FROM_EMAIL);
  if (configured) {
    return {
      ok: true,
      from: configured,
    };
  }

  const template = await buildHimalayaTemplate({
    mode: "write",
    account,
    maxRawBytes,
  });
  if (!template.ok) return template;

  const headers = parseEmailHeaders(template.raw_json);
  const from = headerValue(headers, "from");
  if (!from) {
    return {
      ok: false,
      status: "missing_from_address",
      message: "Could not determine the configured Himalaya From address.",
      answer_text: "I could not determine the configured email From address.",
    };
  }

  return {
    ok: true,
    from,
  };
}

async function saveRawHimalayaMessage({
  rawMessage,
  draftFolder,
  account,
  maxRawBytes,
}) {
  if (!rawMessage) {
    return {
      ok: false,
      status: "empty_message",
      message: "No raw email message was generated to save.",
      answer_text: "No email draft content was generated to save.",
    };
  }

  const args = [
    "-o",
    "json",
    "message",
    "save",
    "--folder",
    normalizeString(draftFolder, "[Gmail]/Drafts"),
  ];
  if (account) args.push("--account", normalizeString(account));
  args.push(...splitCliArgument(rawMessage));

  return runCli({
    command: process.env.HIMALAYA_BIN || "himalaya",
    args,
    timeoutMs: 20_000,
    maxRawBytes,
  });
}

function splitCliArgument(value, maxBytes = MAX_CLI_ARGUMENT_BYTES) {
  const text = String(value || "");
  if (Buffer.byteLength(text) <= maxBytes) return [text];

  const chunks = [];
  let chunk = "";
  let chunkBytes = 0;

  for (const char of text) {
    const charBytes = Buffer.byteLength(char);
    if (chunk && chunkBytes + charBytes > maxBytes) {
      chunks.push(chunk);
      chunk = char;
      chunkBytes = charBytes;
    } else {
      chunk += char;
      chunkBytes += charBytes;
    }
  }

  if (chunk) chunks.push(chunk);
  return chunks;
}

function savedHimalayaMessageId(result) {
  const parsed = result?.parsed_json;
  if (!parsed || typeof parsed !== "object") return "";

  const candidate =
    parsed.id ||
    parsed.envelope?.id ||
    parsed.message?.id ||
    (Array.isArray(parsed) ? parsed[0]?.id : "");

  return candidate == null ? "" : String(candidate);
}

async function sendRawHimalayaMessage({
  rawMessage,
  account,
  maxRawBytes,
}) {
  if (!rawMessage) {
    return {
      ok: false,
      status: "empty_message",
      message: "No raw email message was generated to send.",
      answer_text: "No email content was generated to send.",
    };
  }

  const args = ["-o", "json", "message", "send"];
  if (account) args.push("--account", normalizeString(account));

  return runCli({
    command: process.env.HIMALAYA_BIN || "himalaya",
    args,
    timeoutMs: clampInteger(
      process.env.HIMALAYA_SEND_TIMEOUT_MS,
      2_000,
      40_000,
      DEFAULT_HIMALAYA_SEND_TIMEOUT_MS
    ),
    maxRawBytes,
    input: rawMessage,
  });
}

async function exportHimalayaRawMessage({
  id,
  folder,
  account,
  maxOriginalBytes,
  maxRawBytes,
}) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "phoneclaw-forward-"));
  const destination = path.join(tmpDir, "original.eml");

  try {
    const args = [
      "message",
      "export",
      "--folder",
      normalizeString(folder, "INBOX"),
      "--full",
      "--destination",
      destination,
    ];
    if (account) args.push("--account", normalizeString(account));
    args.push(normalizeString(id));

    const result = await runCli({
      command: process.env.HIMALAYA_BIN || "himalaya",
      args,
      timeoutMs: 30_000,
      maxRawBytes,
    });

    if (!result.ok) {
      return {
        ...result,
        command: "himalaya message export",
      };
    }

    const fileStat = await stat(destination);
    if (fileStat.size > maxOriginalBytes) {
      return {
        ok: false,
        status: "original_email_too_large",
        command: "himalaya message export",
        size_bytes: fileStat.size,
        max_original_bytes: maxOriginalBytes,
        message:
          "The original email is too large to safely embed in a Himalaya draft command.",
        answer_text:
          "That email is too large to safely forward as a preserved draft with the current Himalaya wrapper.",
      };
    }

    const rawMessageBuffer = await readFile(destination);
    return {
      ...compactCliResult(result),
      ok: true,
      status: "ok",
      command: "himalaya message export",
      size_bytes: rawMessageBuffer.byteLength,
      raw_message_buffer: rawMessageBuffer,
      answer_text: "Exported the original email for forwarding.",
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function emailSendAnswerText(result, { to, subject }) {
  if (result.ok) {
    return `Sent the emergency email to ${to} with subject "${subject}".`;
  }
  if (result.status === "cli_timeout") {
    return "The emergency email send timed out before Himalaya confirmed completion. I cannot claim it was sent; check Sent Mail before retrying.";
  }
  return result.answer_text || "The emergency email send failed.";
}

function buildRawEmailMessage({
  from,
  to,
  cc,
  bcc,
  subject,
  body,
  inReplyTo,
  references,
}) {
  const headers = [
    ["From", normalizeHeaderValue(from)],
    ["To", normalizeHeaderValue(to)],
    ["Cc", normalizeHeaderValue(cc)],
    ["Bcc", normalizeHeaderValue(bcc)],
    ["Subject", normalizeHeaderValue(subject)],
    ["In-Reply-To", normalizeHeaderValue(inReplyTo)],
    ["References", normalizeHeaderValue(references)],
    ["Date", new Date().toUTCString()],
    ["Message-ID", generatedMessageId()],
    ["MIME-Version", "1.0"],
    ["Content-Type", "text/plain; charset=UTF-8"],
    ["Content-Transfer-Encoding", "8bit"],
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`);

  return `${headers.join("\r\n")}\r\n\r\n${normalizeEmailBody(body)}\r\n`;
}

function buildForwardRawEmailMessage({
  from,
  to,
  cc,
  bcc,
  subject,
  body,
  original,
}) {
  const alternativeBoundary = mimeBoundary("phoneclaw-forward-alt");
  const plainBody = buildForwardPlainBody({ body, original });
  const htmlBody = buildForwardHtmlBody({ body, original });

  const headers = [
    ["From", normalizeHeaderValue(from)],
    ["To", normalizeHeaderValue(to)],
    ["Cc", normalizeHeaderValue(cc)],
    ["Bcc", normalizeHeaderValue(bcc)],
    ["Subject", normalizeHeaderValue(subject)],
    ["Date", new Date().toUTCString()],
    ["Message-ID", generatedMessageId()],
    ["MIME-Version", "1.0"],
    ["Content-Type", `multipart/alternative; boundary="${alternativeBoundary}"`],
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`);

  return [
    headers.join("\r\n"),
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    plainBody,
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    htmlBody,
    "",
    `--${alternativeBoundary}--`,
    "",
  ].join("\r\n");
}

function buildReplyRawEmailMessage({
  from,
  to,
  cc,
  subject,
  body,
  inReplyTo,
  references,
  original,
}) {
  const alternativeBoundary = mimeBoundary("phoneclaw-reply-alt");
  const plainBody = buildReplyPlainBody({ body, original });
  const htmlBody = buildReplyHtmlBody({ body, original });

  const headers = [
    ["From", normalizeHeaderValue(from)],
    ["To", normalizeHeaderValue(to)],
    ["Cc", normalizeHeaderValue(cc)],
    ["Subject", normalizeHeaderValue(subject)],
    ["In-Reply-To", normalizeHeaderValue(inReplyTo)],
    ["References", normalizeHeaderValue(references)],
    ["Date", new Date().toUTCString()],
    ["Message-ID", generatedMessageId()],
    ["MIME-Version", "1.0"],
    ["Content-Type", `multipart/alternative; boundary="${alternativeBoundary}"`],
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`);

  return [
    headers.join("\r\n"),
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    plainBody,
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    htmlBody,
    "",
    `--${alternativeBoundary}--`,
    "",
  ].join("\r\n");
}

function buildForwardPlainBody({ body, original }) {
  const metadata = forwardedMetadata(original);
  const originalPlain =
    original.plain ||
    (original.html
      ? htmlToText(original.html, { wordwrap: false, selectors: [{ selector: "a", options: { ignoreHref: true } }] })
      : "");

  return [
    normalizeEmailBody(body),
    "",
    "-------- Forwarded Message --------",
    ...metadata.map(([label, value]) => `${label}: ${value}`),
    "",
    normalizeEmailBody(originalPlain),
  ]
    .filter((line, index, lines) => line || index < lines.length - 1)
    .join("\r\n")
    .trimEnd();
}

function buildReplyPlainBody({ body, original }) {
  const originalPlain = originalPlainText(original);
  const intro = replyIntro(original);
  const quoted = normalizeEmailBody(originalPlain)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\r\n");

  return [
    normalizeEmailBody(body),
    "",
    intro,
    quoted,
  ]
    .filter((line, index, lines) => line || index < lines.length - 1)
    .join("\r\n")
    .trimEnd();
}

function buildForwardHtmlBody({ body, original }) {
  const metadataRows = forwardedMetadata(original)
    .map(
      ([label, value]) =>
        `<tr><th style="text-align:left;vertical-align:top;padding:2px 10px 2px 0;color:#555;">${escapeHtml(label)}</th><td style="padding:2px 0;">${escapeHtml(value)}</td></tr>`
    )
    .join("");
  const noteHtml = normalizeEmailBody(body)
    ? `<div>${textToHtml(normalizeEmailBody(body))}</div><br>`
    : "";
  const originalHtml = original.html
    ? htmlBodyFragment(original.html)
    : `<pre style="white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(original.plain || "")}</pre>`;

  return [
    "<!doctype html>",
    '<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.45;color:#111;">',
    noteHtml,
    '<div class="phoneclaw-forwarded-message">',
    '<hr style="border:0;border-top:1px solid #ddd;margin:18px 0;">',
    '<p style="margin:0 0 8px 0;color:#555;">Forwarded message</p>',
    `<table style="border-collapse:collapse;margin:0 0 14px 0;">${metadataRows}</table>`,
    '<blockquote style="margin:0;padding:0 0 0 14px;border-left:3px solid #ddd;">',
    originalHtml,
    "</blockquote>",
    "</div>",
    "</body></html>",
  ].join("");
}

function buildReplyHtmlBody({ body, original }) {
  const noteHtml = normalizeEmailBody(body)
    ? `<div>${textToHtml(normalizeEmailBody(body))}</div><br>`
    : "";
  const originalHtml = original.html
    ? htmlBodyFragment(original.html)
    : `<pre style="white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(original.plain || "")}</pre>`;

  return [
    "<!doctype html>",
    '<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.45;color:#111;">',
    noteHtml,
    `<div style="margin:0 0 8px 0;color:#555;">${escapeHtml(replyIntro(original))}</div>`,
    '<blockquote style="margin:0;padding:0 0 0 14px;border-left:3px solid #ddd;">',
    originalHtml,
    "</blockquote>",
    "</body></html>",
  ].join("");
}

function parseForwardOriginal(rawMessageBuffer) {
  const rawMessage = rawMessageBuffer.toString("latin1");
  const root = parseMimeEntity(rawMessage);
  const htmlPart = findMimePart(root, "text/html");
  const plainPart = findMimePart(root, "text/plain");

  return {
    headers: root.headers,
    html: htmlPart ? decodeMimePartBody(htmlPart) : "",
    plain: plainPart ? decodeMimePartBody(plainPart) : "",
  };
}

function parseEmailHeaders(value) {
  const text = String(value || "");
  const headerText = text.split(/\r?\n\r?\n/, 1)[0] || "";
  const headers = {};
  let currentKey = "";

  for (const line of headerText.split(/\r?\n/)) {
    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] = `${headers[currentKey]} ${line.trim()}`.trim();
      continue;
    }

    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    currentKey = match[1].trim().toLowerCase();
    headers[currentKey] = match[2].trim();
  }

  return headers;
}

function headerValue(headers, key) {
  return normalizeHeaderValue(headers?.[String(key).toLowerCase()]);
}

function ensureReplySubject(subject) {
  const normalized = normalizeHeaderValue(subject);
  if (!normalized) return "Re:";
  return /^re:/i.test(normalized) ? normalized : `Re: ${normalized}`;
}

function ensureForwardSubject(subject) {
  const normalized = normalizeHeaderValue(subject);
  if (!normalized) return "Fwd:";
  return /^(fwd?|fw):/i.test(normalized) ? normalized : `Fwd: ${normalized}`;
}

function normalizeEmailBody(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

function forwardedMetadata(original) {
  const headers = original?.headers || {};
  return [
    ["Date", decodedHeaderValue(headerValue(headers, "date"))],
    ["From", decodedHeaderValue(headerValue(headers, "from"))],
    ["To", decodedHeaderValue(headerValue(headers, "to"))],
    ["Cc", decodedHeaderValue(headerValue(headers, "cc"))],
    ["Subject", decodedHeaderValue(headerValue(headers, "subject"))],
  ].filter(([, value]) => value);
}

function replyIntro(original) {
  const headers = original?.headers || {};
  const date = decodedHeaderValue(headerValue(headers, "date"));
  const from = decodedHeaderValue(headerValue(headers, "from"));
  if (date && from) return `On ${date}, ${from} wrote:`;
  if (from) return `${from} wrote:`;
  return "Previous message:";
}

function originalPlainText(original) {
  if (original?.plain) return original.plain;
  if (!original?.html) return "";
  return htmlToText(original.html, {
    wordwrap: false,
    selectors: [{ selector: "a", options: { ignoreHref: true } }],
  });
}

function parseMimeEntity(rawEntity) {
  const { headerText, body } = splitMimeHeadersAndBody(rawEntity);
  const headers = parseEmailHeaders(headerText);
  const contentType = parseContentType(headerValue(headers, "content-type"));
  const entity = {
    headers,
    content_type: contentType.value,
    content_type_params: contentType.params,
    transfer_encoding: headerValue(headers, "content-transfer-encoding").toLowerCase(),
    body,
    parts: [],
  };

  if (entity.content_type.startsWith("multipart/") && contentType.params.boundary) {
    entity.parts = splitMultipartBody(body, contentType.params.boundary).map(parseMimeEntity);
  }

  return entity;
}

function findMimePart(entity, contentType) {
  if (!entity) return null;
  if (entity.content_type === contentType) return entity;

  for (const part of entity.parts || []) {
    const match = findMimePart(part, contentType);
    if (match) return match;
  }

  return null;
}

function decodeMimePartBody(part) {
  const bytes = decodeTransferToBuffer(part.body, part.transfer_encoding);
  return decodeTextBuffer(bytes, part.content_type_params.charset || "utf-8");
}

function splitMimeHeadersAndBody(value) {
  const text = String(value || "");
  const match = text.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) {
    return { headerText: text, body: "" };
  }

  const headerText = text.slice(0, match.index);
  const body = text.slice(match.index + match[0].length);
  return { headerText, body };
}

function parseContentType(value) {
  const parts = splitHeaderParameters(value);
  const type = normalizeString(parts.shift(), "text/plain").toLowerCase();
  const params = {};

  for (const part of parts) {
    const equalIndex = part.indexOf("=");
    if (equalIndex < 0) continue;
    const key = part.slice(0, equalIndex).trim().toLowerCase();
    const rawValue = part.slice(equalIndex + 1).trim();
    params[key] = unquoteHeaderValue(rawValue);
  }

  return { value: type, params };
}

function splitHeaderParameters(value) {
  const text = String(value || "");
  const parts = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      current += char;
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ";" && !inQuotes) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function splitMultipartBody(body, boundary) {
  const marker = `--${boundary}`;
  const segments = String(body || "").split(marker).slice(1);
  const parts = [];

  for (const segment of segments) {
    if (segment.startsWith("--")) break;
    const cleaned = segment
      .replace(/^\r?\n/, "")
      .replace(/\r?\n$/, "");
    if (cleaned.trim()) parts.push(cleaned);
  }

  return parts;
}

function decodeTransferToBuffer(body, transferEncoding) {
  const normalized = normalizeString(transferEncoding).toLowerCase();
  if (normalized === "base64") {
    return Buffer.from(String(body || "").replace(/\s+/g, ""), "base64");
  }
  if (normalized === "quoted-printable") {
    return decodeQuotedPrintableToBuffer(body);
  }
  return Buffer.from(String(body || ""), "latin1");
}

function decodeQuotedPrintableToBuffer(value) {
  const bytes = [];
  const text = String(value || "").replace(/=\r?\n/g, "");

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const hex = text.slice(index + 1, index + 3);
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(text.charCodeAt(index) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

function decodeTextBuffer(buffer, charset) {
  const label = normalizeString(charset, "utf-8").toLowerCase();
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return buffer.toString(label === "iso-8859-1" || label === "latin1" ? "latin1" : "utf8");
  }
}

function decodedHeaderValue(value) {
  return normalizeHeaderValue(decodeMimeWords(value));
}

function decodeMimeWords(value) {
  return String(value || "").replace(
    /=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g,
    (_match, charset, encoding, encoded) => {
      try {
        const bytes =
          encoding.toLowerCase() === "b"
            ? Buffer.from(encoded.replace(/\s+/g, ""), "base64")
            : decodeQuotedPrintableToBuffer(encoded.replace(/_/g, " "));
        return decodeTextBuffer(bytes, charset);
      } catch {
        return _match;
      }
    }
  );
}

function htmlBodyFragment(html) {
  const text = String(html || "");
  const styleTags = [...text.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)]
    .map((match) => match[0])
    .join("");
  const bodyMatch = text.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return `${styleTags}${bodyMatch ? bodyMatch[1] : text}`;
}

function textToHtml(value) {
  return escapeHtml(value)
    .replace(/\n{2,}/g, (match) => "<br>".repeat(match.length))
    .replace(/\n/g, "<br>");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function unquoteHeaderValue(value) {
  const text = String(value || "").trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return text;
}

function mimeBoundary(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function generatedMessageId() {
  const host = normalizeString(process.env.PHONECLAW_MESSAGE_ID_HOST, "aifurman.com")
    .replace(/^@+/, "")
    .replace(/[^A-Za-z0-9.-]/g, "")
    .replace(/^\.+|\.+$/g, "");
  const safeHost = host || "aifurman.com";
  return `<phoneclaw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}@${safeHost}>`;
}

function compactEnvelope(envelope) {
  return {
    id: envelope.id ?? "",
    subject: envelope.subject || "",
    from: summarizeAddressList(envelope.from),
    to: summarizeAddressList(envelope.to),
    date: envelope.date || "",
    flags: envelope.flags || [],
    has_attachment: Boolean(envelope.has_attachment),
  };
}

function compactOtterSpeech(speech) {
  return {
    otid: speech.otid || speech.speech_id || "",
    speech_id: speech.speech_id || "",
    title: speech.title || "",
    created_at: speech.created_at || speech.createdAt || null,
    modified_time: speech.modified_time || speech.modifiedTime || null,
    start_time: speech.start_time || speech.startTime || null,
    duration: speech.duration || null,
    owner_name: speech.owner?.name || speech.owner_name || "",
    summary_status: speech.summary_status || speech.speech_outline_status || "",
  };
}

function searchOtterTranscriptSegments(root, { query, speaker, size }) {
  const queryNeedle = normalizeSearchText(query);
  const speakerNeedle = normalizeSearchText(speaker);
  const limit = clampInteger(size, 1, 100, 20);
  const segments = collectOtterTranscriptSegments(root);
  const seen = new Set();
  const matches = [];

  for (const segment of segments) {
    const textHaystack = normalizeSearchText(segment.text);
    const speakerHaystack = normalizeSearchText(segment.speaker);
    if (queryNeedle && !textHaystack.includes(queryNeedle)) continue;
    if (speakerNeedle && !speakerHaystack.includes(speakerNeedle)) continue;

    const key = `${segment.speaker}\n${segment.start_time}\n${segment.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(segment);
    if (matches.length >= limit) break;
  }

  return matches;
}

function collectOtterTranscriptSegments(value, path = "", segments = []) {
  if (!value || typeof value !== "object") return segments;

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectOtterTranscriptSegments(item, `${path}/${index}`, segments)
    );
    return segments;
  }

  const text = otterSegmentText(value);
  if (text) {
    segments.push({
      text,
      speaker: otterSegmentSpeaker(value),
      start_time: otterTimeText(value.start_time ?? value.startTime ?? value.start ?? value.start_offset),
      end_time: otterTimeText(value.end_time ?? value.endTime ?? value.end ?? value.end_offset),
      path,
    });
  }

  for (const [key, child] of Object.entries(value)) {
    if (!child || typeof child !== "object") continue;
    collectOtterTranscriptSegments(child, `${path}/${key}`, segments);
  }

  return segments;
}

function otterTimeText(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value);
}

function otterSegmentText(value) {
  const direct =
    value.text ||
    value.transcript ||
    value.transcript_text ||
    value.display_text ||
    value.content ||
    value.sentence;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  if (Array.isArray(value.words)) {
    const words = value.words
      .map((word) => (typeof word === "string" ? word : word?.word || word?.text || ""))
      .filter(Boolean)
      .join(" ");
    if (words.trim()) return words.trim();
  }

  return "";
}

function otterSegmentSpeaker(value) {
  const direct =
    value.speaker_name ||
    value.speakerName ||
    value.speaker_label ||
    value.speakerLabel ||
    value.user_name ||
    value.userName ||
    value.person_name ||
    value.personName;
  if (direct) return String(direct);

  if (typeof value.speaker === "string") return value.speaker;
  if (value.speaker && typeof value.speaker === "object") {
    return (
      value.speaker.name ||
      value.speaker.display_name ||
      value.speaker.displayName ||
      value.speaker.label ||
      value.speaker.id ||
      ""
    );
  }

  return "";
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeAddressList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const name = item.name || item.display_name || "";
      const address = item.address || item.email || "";
      return name && address ? `${name} <${address}>` : name || address;
    })
    .filter(Boolean)
    .join(", ");
}

async function himalayaEmailListAllPages({
  folder,
  query,
  account,
  pageSize,
  maxPages,
  maxItems,
  maxRawBytes,
}) {
  const items = [];
  let pagesScanned = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const result = await runHimalayaEnvelopeListPage({
      query,
      folder,
      account,
      page: pageNumber,
      pageSize,
      maxRawBytes,
    });

    if (!result.ok) {
      if (pageNumber > 1 && isHimalayaPageOutOfBounds(result)) {
        return emailListResponse({
          folder,
          query,
          items,
          pageSize,
          maxItems,
          pagesScanned,
          allPages: true,
          complete: true,
          capped: false,
          hasMore: false,
        });
      }

      return {
        ...compactCliResult(result),
        command: "himalaya envelope list",
        folder,
        query,
        all_pages: true,
        page_size: pageSize,
        returned_count: items.length,
        total_count: null,
        pages_scanned: pagesScanned,
        max_items: maxItems,
        has_more: null,
        complete: false,
        exact: false,
        capped: false,
        items,
        answer_text:
          result.answer_text || `Himalaya could not list every email in ${folder}.`,
      };
    }

    const pageItems = Array.isArray(result.parsed_json)
      ? result.parsed_json.map(compactEnvelope)
      : [];

    const remaining = maxItems - items.length;
    if (pageItems.length > remaining) {
      items.push(...pageItems.slice(0, remaining));
      pagesScanned = pageNumber;
      return emailListResponse({
        folder,
        query,
        items,
        pageSize,
        maxItems,
        pagesScanned,
        allPages: true,
        complete: false,
        capped: true,
        hasMore: true,
      });
    }

    items.push(...pageItems);
    pagesScanned = pageNumber;

    if (pageItems.length < pageSize) {
      return emailListResponse({
        folder,
        query,
        items,
        pageSize,
        maxItems,
        pagesScanned,
        allPages: true,
        complete: true,
        capped: false,
        hasMore: false,
      });
    }

    if (items.length >= maxItems) {
      const probe = await runHimalayaEnvelopeListPage({
        query,
        folder,
        account,
        page: pageNumber + 1,
        pageSize,
        maxRawBytes,
      });
      pagesScanned = pageNumber + 1;

      if (probe.ok) {
        const probeItems = Array.isArray(probe.parsed_json) ? probe.parsed_json : [];
        const hasMore = probeItems.length > 0;
        return emailListResponse({
          folder,
          query,
          items,
          pageSize,
          maxItems,
          pagesScanned,
          allPages: true,
          complete: !hasMore,
          capped: hasMore,
          hasMore,
        });
      }

      if (isHimalayaPageOutOfBounds(probe)) {
        return emailListResponse({
          folder,
          query,
          items,
          pageSize,
          maxItems,
          pagesScanned,
          allPages: true,
          complete: true,
          capped: false,
          hasMore: false,
        });
      }

      return emailListResponse({
        folder,
        query,
        items,
        pageSize,
        maxItems,
        pagesScanned,
        allPages: true,
        complete: false,
        capped: true,
        hasMore: null,
      });
    }
  }

  return emailListResponse({
    folder,
    query,
    items,
    pageSize,
    maxItems,
    pagesScanned,
    allPages: true,
    complete: false,
    capped: true,
    hasMore: null,
  });
}

function runHimalayaEnvelopeListPage({
  folder,
  query,
  account,
  page,
  pageSize,
  maxRawBytes,
}) {
  const args = [
    "-o",
    "json",
    "envelope",
    "list",
    "--folder",
    folder,
    "--page",
    String(page),
    "--page-size",
    String(pageSize),
  ];

  if (account) args.push("--account", normalizeString(account));
  if (query) args.push(query);

  return runCli({
    command: process.env.HIMALAYA_BIN || "himalaya",
    args,
    maxRawBytes,
  });
}

function emailListResponse({
  folder,
  query,
  items,
  pageSize,
  maxItems,
  pagesScanned,
  allPages,
  complete,
  capped,
  hasMore,
}) {
  return {
    ok: true,
    status: "ok",
    exit_code: 0,
    command: "himalaya envelope list",
    folder,
    query,
    all_pages: allPages,
    page_size: pageSize,
    returned_count: items.length,
    total_count: complete ? items.length : null,
    pages_scanned: pagesScanned,
    max_items: maxItems,
    has_more: hasMore,
    complete,
    exact: complete,
    capped,
    items,
    answer_text: formatEmailListAnswer(items, folder, {
      pageSize,
      maxItems,
      allPages,
      pagesScanned,
      exact: complete,
      capped,
      hasMore,
    }),
  };
}

function compactCliResult(result) {
  const { raw_json, raw_truncated, parsed_json, stderr, ...compact } = result;
  return {
    ...compact,
    raw_json: "",
    raw_truncated: false,
    stderr: stderr ? truncateUtf8(stderr, 1_000).value : "",
  };
}

function isHimalayaPageOutOfBounds(result) {
  const text = `${result.message || ""}\n${result.stderr || ""}`.toLowerCase();
  return text.includes("out of bound") || text.includes("out of range");
}

function formatEmailListAnswer(
  envelopes,
  folder,
  {
    page,
    pageSize,
    maxItems,
    allPages = false,
    pagesScanned = 1,
    exact = false,
    capped = false,
    hasMore = false,
  } = {}
) {
  const moreText =
    hasMore === true
      ? " There are more matching emails beyond this cap."
      : hasMore === null
        ? " There may be more matching emails beyond this cap."
        : "";
  const qualifier = capped
    ? ` I stopped after ${pagesScanned} pages and returned at most ${maxItems || envelopes.length} emails.${moreText}`
    : "";

  if (envelopes.length === 0) {
    return allPages
      ? `Himalaya found no matching emails in ${folder}.${qualifier}`
      : `Himalaya found no matching emails on page ${page || 1} of ${folder}.`;
  }

  const lines = envelopes.slice(0, 5).map((item, index) => {
    const subject = item.subject || "(no subject)";
    const sender = item.from ? ` from ${item.from}` : "";
    return `${index + 1}. ${subject}${sender}, dated ${item.date || "unknown date"}.`;
  });

  if (allPages) {
    const totalText = exact
      ? `Himalaya returned all ${envelopes.length} email envelopes from ${folder}.`
      : `Himalaya returned ${envelopes.length} email envelopes from ${folder}, but this is capped and may be partial.`;
    return [totalText + qualifier, ...lines].filter(Boolean).join("\n");
  }

  const totalHint = exact
    ? ` Since page 1 returned fewer than the page size, this is the complete list for ${folder}.`
    : " Use all_pages=true on himalaya_email_list when Andrew asks for the complete list or total count.";

  return [
    `Himalaya returned ${envelopes.length} email envelopes from page ${page || 1} of ${folder}.${totalHint}`,
    pageSize ? `Page size: ${pageSize}.` : "",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatOtterListAnswer(speeches) {
  if (speeches.length === 0) {
    return "Otter returned no transcripts for that query.";
  }

  const lines = speeches.slice(0, 5).map((speech, index) => {
    const title = speech.title || "Untitled transcript";
    const date = speech.created_at || speech.modified_at || speech.date;
    return `${index + 1}. ${title}${date ? `, dated ${date}` : ""}.`;
  });
  return [
    `Otter returned ${speeches.length} transcripts. Use the structured tool result to pick a transcript if Andrew asks for raw JSON.`,
    ...lines,
  ].join("\n");
}

function formatGithubCliAnswer(action, parsed) {
  if (Array.isArray(parsed)) {
    return `GitHub CLI returned ${parsed.length} items for ${action}.`;
  }

  if (parsed && typeof parsed === "object") {
    const title = parsed.title || parsed.nameWithOwner || parsed.url || action;
    return `GitHub CLI returned data for ${title}.`;
  }

  return `GitHub CLI completed ${action}.`;
}

function splitSearchQuery(query) {
  return normalizeString(query)
    .match(/"[^"]+"|'[^']+'|\S+/g)
    ?.map((part) => part.replace(/^["']|["']$/g, ""))
    .filter(Boolean) || [];
}

function missingField(field, message) {
  return {
    ok: false,
    status: "missing_field",
    field,
    message,
    items: [],
    answer_text: message,
  };
}

function confirmationRequired(message) {
  return {
    ok: false,
    status: "confirmation_required",
    message,
    answer_text: message,
  };
}

function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { value: text, truncated: false };
  }

  return {
    value: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

function redact(value) {
  return String(value || "")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_[redacted]")
    .replace(/gh[opsu]_[A-Za-z0-9_]+/g, "gh_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token":"[redacted]"');
}

function normalizeString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeIdList(ids, fallbackId) {
  const values = Array.isArray(ids)
    ? ids
    : normalizeString(ids)
      ? normalizeString(ids)
          .split(",")
          .map((value) => value.trim())
      : [];
  if (values.length === 0 && normalizeString(fallbackId)) values.push(fallbackId);
  return Array.from(
    new Set(values.map((value) => normalizeString(value)).filter(Boolean))
  );
}

function normalizeHeaderValue(value) {
  return normalizeString(value).replace(/[\r\n]+/g, " ").trim();
}

function hasEmailAddress(value) {
  return /[^\s@<>,"']+@[^\s@<>,"']+\.[^\s@<>,"']+/.test(String(value || ""));
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeString(value).toLowerCase().replaceAll("-", "_");
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeIssueNumber(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number <= 0) return "";
  return String(number);
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return Boolean(value);
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function shellWord(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@-]+$/.test(text)) return text;
  return JSON.stringify(text);
}
