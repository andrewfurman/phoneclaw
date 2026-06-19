import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_BUFFER_BYTES = 1_000_000;
const DEFAULT_MAX_RAW_BYTES = 200_000;
const MAX_RAW_BYTES = 750_000;
const MAX_LIST_RESULTS = 50;

export async function himalayaEmailList({
  query = "",
  folder = "INBOX",
  account,
  page = 1,
  pageSize = 10,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const args = [
    "-o",
    "json",
    "envelope",
    "list",
    "--folder",
    normalizeString(folder, "INBOX"),
    "--page",
    String(clampInteger(page, 1, 100, 1)),
    "--page-size",
    String(clampInteger(pageSize, 1, MAX_LIST_RESULTS, 10)),
  ];

  if (account) args.push("--account", normalizeString(account));
  if (query) args.push(normalizeString(query));

  const result = await runCli({
    command: process.env.HIMALAYA_BIN || "himalaya",
    args,
    maxRawBytes,
  });

  const envelopes = Array.isArray(result.parsed_json)
    ? result.parsed_json.map(compactEnvelope)
    : [];

  return {
    ...result,
    command: "himalaya envelope list",
    folder: normalizeString(folder, "INBOX"),
    query: normalizeString(query),
    returned_count: envelopes.length,
    items: envelopes,
    answer_text: result.ok
      ? formatEmailListAnswer(envelopes, normalizeString(folder, "INBOX"))
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
  size = 20,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const otid = normalizeString(speechId || id);
  const normalizedQuery = normalizeString(query);
  if (!otid) {
    return missingField("speech_id", "An Otter speech otid is required.");
  }
  if (!normalizedQuery) {
    return missingField("query", "A search query is required.");
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
  const issueViewFields = `${issueFields},body`;
  const prFields =
    "number,title,state,author,labels,assignees,createdAt,updatedAt,url,reviewDecision,isDraft";
  const prViewFields = `${prFields},body,mergeStateStatus,headRefName,baseRefName,files,comments,reviews`;

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
    return {
      value: [
        "search",
        action === "search_prs" ? "prs" : "issues",
        query,
        "--limit",
        boundedLimit,
        "--json",
        issueFields,
      ],
    };
  }

  return { error: missingField("action", "Unsupported GitHub CLI action.") };
}

function runCli({ command, args, timeoutMs = DEFAULT_TIMEOUT_MS, maxRawBytes }) {
  const rawLimit = clampInteger(maxRawBytes, 1_000, MAX_RAW_BYTES, DEFAULT_MAX_RAW_BYTES);

  return new Promise((resolve) => {
    execFile(
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
          exit_code: 0,
          raw_json: truncated.value,
          raw_truncated: truncated.truncated,
          stderr: truncateUtf8(cleanStderr, 10_000).value,
          parsed_json: parsed,
          answer_text: "The CLI command completed successfully.",
        });
      }
    );
  });
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

function summarizeAddressList(value) {
  if (!Array.isArray(value)) return String(value || "");
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      const name = item.name || item.display_name || "";
      const address = item.address || item.email || "";
      return name && address ? `${name} <${address}>` : name || address;
    })
    .filter(Boolean)
    .join(", ");
}

function formatEmailListAnswer(envelopes, folder) {
  if (envelopes.length === 0) {
    return `Himalaya found no matching emails in ${folder}.`;
  }

  const lines = envelopes.slice(0, 5).map((item, index) => {
    const subject = item.subject || "(no subject)";
    const sender = item.from ? ` from ${item.from}` : "";
    return `${index + 1}. ${subject}${sender}, dated ${item.date || "unknown date"}.`;
  });
  return [`Himalaya returned ${envelopes.length} email envelopes from ${folder}.`, ...lines].join(
    "\n"
  );
}

function formatOtterListAnswer(speeches) {
  if (speeches.length === 0) {
    return "Otter returned no transcripts for that query.";
  }

  const lines = speeches.slice(0, 5).map((speech, index) => {
    const title = speech.title || speech.otid || "Untitled transcript";
    return `${index + 1}. ${title}. Use otid ${speech.otid} to fetch the raw JSON.`;
  });
  return [`Otter returned ${speeches.length} transcripts.`, ...lines].join("\n");
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
