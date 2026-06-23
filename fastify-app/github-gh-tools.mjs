import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_BUFFER_BYTES = 1_000_000;
const DEFAULT_MAX_RAW_BYTES = 120_000;
const MAX_RAW_BYTES = 250_000;
const DEFAULT_MAX_ENTRIES = 100;
const MAX_ENTRIES = 500;
const DEFAULT_SUMMARY_LIMIT = 5;
const MAX_SUMMARY_LIMIT = 8;

export async function githubSummaryGh({
  itemType = "issues",
  scope = "involved",
  maxResults = DEFAULT_SUMMARY_LIMIT,
  username,
  repo,
  owner,
  organization,
  org,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const normalizedType = normalizeItemType(itemType);
  const normalizedScope = normalizeScope(scope, normalizedType);
  const limit = clampInteger(maxResults, 1, MAX_SUMMARY_LIMIT, DEFAULT_SUMMARY_LIMIT);
  const account = normalizeString(username) || (await fetchAuthenticatedUsername({ maxRawBytes }));
  let normalizedRepo = repo ? normalizeRepo(repo) : "";
  let normalizedOwner = owner ? normalizeQualifierValue(owner) : "";
  let normalizedOrg = normalizeQualifierValue(organization || org || "");
  let query = buildSearchQuery({
    itemType: normalizedType,
    scope: normalizedScope,
    username: account,
    repo: normalizedRepo,
    owner: normalizedOwner,
    organization: normalizedOrg,
  });

  let result = await runGithubIssueSearch({ query, limit, maxRawBytes });
  let fallbackNote = "";
  if (!result.ok) {
    const fallbackContext = githubSearchFallbackContext({
      repo: normalizedRepo,
      owner: normalizedOwner,
      organization: normalizedOrg,
    });
    if (fallbackContext) {
      const fallbackQuery = buildSearchQuery({
        itemType: normalizedType,
        scope: normalizedScope,
        username: account,
        ...fallbackContext,
      });
      const fallbackResult = await runGithubIssueSearch({
        query: fallbackQuery,
        limit,
        maxRawBytes,
      });
      if (fallbackResult.ok) {
        result = fallbackResult;
        query = fallbackQuery;
        normalizedRepo = fallbackContext.repo;
        normalizedOwner = fallbackContext.owner;
        normalizedOrg = fallbackContext.organization;
        fallbackNote =
          " Retried with a kebab-case GitHub login because the original owner or organization was not searchable.";
      }
    }
  }

  if (!result.ok) {
    return githubGhFailure(result, {
      status: "github_search_failed",
      query,
      items: [],
    });
  }

  const body = result.parsed_json && typeof result.parsed_json === "object"
    ? result.parsed_json
    : {};
  const items = (body.items || []).map(summarizeSearchItem);

  return {
    ...compactGhResult(result),
    ok: true,
    status: "ok",
    command: "gh api search/issues",
    account,
    item_type: normalizedType,
    scope: normalizedScope,
    repo: normalizedRepo || null,
    owner: normalizedOwner || null,
    organization: normalizedOrg || null,
    total_count: body.total_count || items.length,
    returned_count: items.length,
    query,
    gh_equivalent: `gh api -X GET search/issues -f ${shellWord(`q=${query}`)}`,
    source_note:
      `Results come from GitHub CLI using the gh-authenticated EC2 service user.${fallbackNote}`,
    items,
    answer_text: formatGithubSummaryAnswer({
      account,
      itemType: normalizedType,
      scope: normalizedScope,
      repo: normalizedRepo,
      owner: normalizedOwner,
      organization: normalizedOrg,
      totalCount: body.total_count || items.length,
      items,
    }),
  };
}

function runGithubIssueSearch({ query, limit, maxRawBytes }) {
  return runGh({
    args: [
      "api",
      "-X",
      "GET",
      "search/issues",
      "-f",
      `q=${query}`,
      "-f",
      "sort=updated",
      "-f",
      "order=desc",
      "-F",
      `per_page=${limit}`,
    ],
    maxRawBytes,
  });
}

export async function githubCliLsGh({
  repo,
  path = "",
  ref,
  recursive = false,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const normalizedRepo = normalizeRepo(repo);
  const normalizedPath = normalizePath(path);
  const normalizedRef = normalizeString(ref);
  const limit = clampInteger(maxEntries, 1, MAX_ENTRIES, DEFAULT_MAX_ENTRIES);

  if (toBoolean(recursive)) {
    let lastTreeResult = null;
    for (const candidateRepo of githubRepoCandidates(normalizedRepo)) {
      try {
        const treeResult = await githubCliTreeGh({
          repo: candidateRepo,
          path: normalizedPath,
          ref: normalizedRef,
          maxEntries: limit,
          maxRawBytes,
        });
        if (treeResult.ok) return treeResult;
        lastTreeResult = treeResult;
      } catch (error) {
        lastTreeResult = {
          ok: false,
          status: "github_tree_failed",
          message: error?.message || "Could not read the GitHub tree.",
          repo: candidateRepo,
          path: normalizedPath,
          ref: normalizedRef || null,
          entries: [],
          answer_text: error?.message || "Could not read the GitHub tree.",
        };
      }
    }
    return lastTreeResult;
  }

  let result = null;
  let effectiveRepo = normalizedRepo;
  for (const candidateRepo of githubRepoCandidates(normalizedRepo)) {
    const args = ["api", "-X", "GET", githubContentsEndpoint(candidateRepo, normalizedPath)];
    if (normalizedRef) args.push("-f", `ref=${normalizedRef}`);
    result = await runGh({ args, maxRawBytes });
    effectiveRepo = candidateRepo;
    if (result.ok) break;
  }

  if (!result.ok) {
    return githubGhFailure(result, {
      status: "github_ls_failed",
      repo: effectiveRepo,
      path: normalizedPath,
      ref: normalizedRef || null,
      entries: [],
      gh_equivalent: ghLsCommand({ repo: effectiveRepo, path: normalizedPath, ref: normalizedRef }),
    });
  }

  const body = result.parsed_json;
  if (!Array.isArray(body)) {
    return {
      ...compactGhResult(result),
      ok: false,
      status: "path_is_not_directory",
      message: "The requested GitHub path is not a directory. Use github_cli_cat for files.",
      repo: effectiveRepo,
      path: normalizedPath,
      ref: normalizedRef || null,
      gh_equivalent: ghLsCommand({ repo: effectiveRepo, path: normalizedPath, ref: normalizedRef }),
      entries: [],
      answer_text: "That GitHub path is not a directory.",
    };
  }

  const entries = body.map(summarizeContentEntry).sort(compareEntries);
  const limitedEntries = entries.slice(0, limit);

  return {
    ...compactGhResult(result),
    ok: true,
    status: "ok",
    command: "ls",
    repo: effectiveRepo,
    path: normalizedPath,
    ref: normalizedRef || null,
    recursive: false,
    total_count: entries.length,
    returned_count: limitedEntries.length,
    truncated: entries.length > limitedEntries.length,
    gh_equivalent: ghLsCommand({ repo: effectiveRepo, path: normalizedPath, ref: normalizedRef }),
    entries: limitedEntries,
    answer_text: formatLsAnswer({
      repo: effectiveRepo,
      path: normalizedPath,
      entries: limitedEntries,
      totalCount: entries.length,
      truncated: entries.length > limitedEntries.length,
    }),
  };
}

export async function githubCliCatGh({
  repo,
  path,
  ref,
  maxBytes = DEFAULT_MAX_RAW_BYTES,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const normalizedRepo = normalizeRepo(repo);
  const normalizedPath = normalizePath(path);
  const normalizedRef = normalizeString(ref);
  const byteLimit = clampInteger(maxBytes, 1, MAX_RAW_BYTES, DEFAULT_MAX_RAW_BYTES);

  if (!normalizedPath) {
    return missingField("path", "A file path is required.");
  }

  let result = null;
  let effectiveRepo = normalizedRepo;
  for (const candidateRepo of githubRepoCandidates(normalizedRepo)) {
    const args = ["api", "-X", "GET", githubContentsEndpoint(candidateRepo, normalizedPath)];
    if (normalizedRef) args.push("-f", `ref=${normalizedRef}`);
    result = await runGh({ args, maxRawBytes });
    effectiveRepo = candidateRepo;
    if (result.ok) break;
  }

  if (!result.ok) {
    return githubGhFailure(result, {
      status: "github_cat_failed",
      repo: effectiveRepo,
      path: normalizedPath,
      ref: normalizedRef || null,
      content: "",
      gh_equivalent: ghCatCommand({ repo: effectiveRepo, path: normalizedPath, ref: normalizedRef }),
    });
  }

  const body = result.parsed_json;
  if (!body || Array.isArray(body) || body.type !== "file") {
    return {
      ...compactGhResult(result),
      ok: false,
      status: "path_is_not_file",
      message: "The requested GitHub path is not a file. Use github_cli_ls for directories.",
      repo: effectiveRepo,
      path: normalizedPath,
      ref: normalizedRef || null,
      gh_equivalent: ghCatCommand({ repo: effectiveRepo, path: normalizedPath, ref: normalizedRef }),
      content: "",
      answer_text: "That GitHub path is not a file.",
    };
  }

  const content = decodeGitHubContent(body);
  const truncatedContent = truncateUtf8(content, byteLimit);

  return {
    ...compactGhResult(result),
    ok: true,
    status: "ok",
    command: "cat",
    repo: effectiveRepo,
    path: normalizedPath,
    ref: normalizedRef || null,
    name: body.name || "",
    sha: body.sha || "",
    size_bytes: body.size ?? utf8ByteLength(content),
    returned_bytes: utf8ByteLength(truncatedContent.value),
    truncated: truncatedContent.truncated,
    encoding: "utf-8",
    gh_equivalent: ghCatCommand({ repo: effectiveRepo, path: normalizedPath, ref: normalizedRef }),
    content: truncatedContent.value,
    answer_text: formatCatAnswer({
      repo: effectiveRepo,
      path: normalizedPath,
      byteLength: body.size ?? utf8ByteLength(content),
      returnedBytes: utf8ByteLength(truncatedContent.value),
      truncated: truncatedContent.truncated,
    }),
  };
}

export async function githubIssueCreateGh({
  repo,
  title,
  body = "",
  labels,
  assignees,
  confirmed,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const confirmation = requireConfirmed(confirmed);
  if (confirmation) return confirmation;

  let normalizedRepo = normalizeRepo(repo);
  const normalizedTitle = normalizeRequiredString(title, "title", 256);
  let result = null;
  for (const candidateRepo of githubRepoCandidates(normalizedRepo)) {
    const args = [
      "api",
      "-X",
      "POST",
      `repos/${encodeRepoName(candidateRepo)}/issues`,
      "-f",
      `title=${normalizedTitle}`,
      "-f",
      `body=${String(body || "")}`,
    ];
    appendArrayFields(args, "labels", normalizeStringArray(labels, "labels"));
    appendArrayFields(args, "assignees", normalizeStringArray(assignees, "assignees"));
    result = await runGh({ args, maxRawBytes });
    normalizedRepo = candidateRepo;
    if (result.ok) break;
  }

  if (!result.ok) {
    return githubGhFailure(result, {
      status: "github_issue_create_failed",
      repo: normalizedRepo,
    });
  }

  const issue = summarizeIssue(result.parsed_json || {});
  return {
    ...compactGhResult(result),
    ok: true,
    status: "ok",
    action: "created",
    repo: normalizedRepo,
    issue,
    gh_equivalent: `gh api -X POST repos/${normalizedRepo}/issues -f title=...`,
    answer_text: `Created issue #${issue.number} in ${normalizedRepo}. Brief summary: ${voiceIssueSummary(issue)}.`,
  };
}

export async function githubIssueUpdateGh({
  repo,
  number,
  issueNumber,
  title,
  body,
  state,
  stateReason,
  state_reason,
  labels,
  assignees,
  confirmed,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const confirmation = requireConfirmed(confirmed);
  if (confirmation) return confirmation;

  let normalizedRepo = normalizeRepo(repo);
  const normalizedNumber = normalizeIssueNumber(issueNumber || number);
  const normalizedStateReason = normalizeOptionalStateReason(stateReason || state_reason);
  const hasUpdateField =
    title !== undefined ||
    body !== undefined ||
    state !== undefined ||
    normalizedStateReason ||
    labels !== undefined ||
    assignees !== undefined;

  if (!hasUpdateField) {
    return {
      ok: false,
      status: "missing_update_fields",
      message:
        "Provide at least one issue field to update: title, body, state, labels, or assignees.",
      repo: normalizedRepo,
      issue_number: normalizedNumber,
      answer_text: "Tell me what to update on that issue first.",
    };
  }

  let result = null;
  for (const candidateRepo of githubRepoCandidates(normalizedRepo)) {
    const args = [
      "api",
      "-X",
      "PATCH",
      `repos/${encodeRepoName(candidateRepo)}/issues/${normalizedNumber}`,
    ];

    if (title !== undefined) args.push("-f", `title=${normalizeRequiredString(title, "title", 256)}`);
    if (body !== undefined) args.push("-f", `body=${String(body)}`);
    if (state !== undefined) args.push("-f", `state=${normalizeState(state)}`);
    if (normalizedStateReason) args.push("-f", `state_reason=${normalizedStateReason}`);
    if (labels !== undefined) appendArrayFields(args, "labels", normalizeStringArray(labels, "labels"));
    if (assignees !== undefined) appendArrayFields(args, "assignees", normalizeStringArray(assignees, "assignees"));

    result = await runGh({ args, maxRawBytes });
    normalizedRepo = candidateRepo;
    if (result.ok) break;
  }

  if (!result.ok) {
    return githubGhFailure(result, {
      status: "github_issue_update_failed",
      repo: normalizedRepo,
      issue_number: normalizedNumber,
    });
  }

  const issue = summarizeIssue(result.parsed_json || {});
  return {
    ...compactGhResult(result),
    ok: true,
    status: "ok",
    action: "updated",
    repo: normalizedRepo,
    issue,
    gh_equivalent: `gh api -X PATCH repos/${normalizedRepo}/issues/${normalizedNumber}`,
    answer_text: `Updated issue #${issue.number} in ${normalizedRepo}. Brief summary: ${voiceIssueSummary(issue)}.`,
  };
}

async function githubCliTreeGh({ repo, path, ref, maxEntries, maxRawBytes }) {
  const resolvedRef = ref || (await fetchDefaultBranch({ repo, maxRawBytes }));
  const args = [
    "api",
    "-X",
    "GET",
    `repos/${encodeRepoName(repo)}/git/trees/${encodeURIComponent(resolvedRef)}`,
    "-f",
    "recursive=1",
  ];
  const result = await runGh({ args, maxRawBytes });
  if (!result.ok) {
    return githubGhFailure(result, {
      status: "github_tree_failed",
      repo,
      path,
      ref: resolvedRef,
      entries: [],
      gh_equivalent: ghTreeCommand({ repo, ref: resolvedRef }),
    });
  }

  const prefix = path ? `${path}/` : "";
  const entries = (result.parsed_json?.tree || [])
    .filter((entry) => !path || entry.path === path || entry.path.startsWith(prefix))
    .filter((entry) => entry.path !== path)
    .map(summarizeTreeEntry)
    .sort(compareEntries);
  const limitedEntries = entries.slice(0, maxEntries);

  return {
    ...compactGhResult(result),
    ok: true,
    status: "ok",
    command: "ls",
    repo,
    path,
    ref: resolvedRef,
    recursive: true,
    total_count: entries.length,
    returned_count: limitedEntries.length,
    truncated: Boolean(result.parsed_json?.truncated) || entries.length > limitedEntries.length,
    github_tree_truncated: Boolean(result.parsed_json?.truncated),
    gh_equivalent: ghTreeCommand({ repo, ref: resolvedRef }),
    entries: limitedEntries,
    answer_text: formatLsAnswer({
      repo,
      path,
      entries: limitedEntries,
      totalCount: entries.length,
      truncated: Boolean(result.parsed_json?.truncated) || entries.length > limitedEntries.length,
      recursive: true,
    }),
  };
}

async function fetchAuthenticatedUsername({ maxRawBytes }) {
  const result = await runGh({
    args: ["api", "user"],
    maxRawBytes,
  });
  if (!result.ok || !result.parsed_json?.login) {
    throw new Error(result.message || "Could not resolve GitHub username from gh.");
  }
  return result.parsed_json.login;
}

async function fetchDefaultBranch({ repo, maxRawBytes }) {
  const result = await runGh({
    args: ["repo", "view", repo, "--json", "defaultBranchRef"],
    maxRawBytes,
  });
  if (!result.ok) throw new Error(result.message || `Could not resolve default branch for ${repo}.`);
  const branch = result.parsed_json?.defaultBranchRef?.name;
  if (!branch) throw new Error(`Could not resolve default branch for ${repo}.`);
  return branch;
}

function runGh({ args, timeoutMs = DEFAULT_TIMEOUT_MS, maxRawBytes = DEFAULT_MAX_RAW_BYTES }) {
  const rawLimit = clampInteger(maxRawBytes, 1_000, MAX_RAW_BYTES, DEFAULT_MAX_RAW_BYTES);
  return new Promise((resolve) => {
    execFile(
      process.env.GH_BIN || "gh",
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
            message: cleanStderr.trim() || error.message || "GitHub CLI command failed.",
            raw_json: truncated.value,
            raw_truncated: truncated.truncated,
            stderr: truncateUtf8(cleanStderr, 10_000).value,
            parsed_json: parsed,
            answer_text:
              cleanStderr.trim() || error.message || "The GitHub CLI command failed.",
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
          answer_text: "The GitHub CLI command completed successfully.",
        });
      }
    );
  });
}

function githubGhFailure(result, extra = {}) {
  return {
    ...compactGhResult(result),
    ok: false,
    status: extra.status || result.status || "github_cli_failed",
    message: result.message || "GitHub CLI request failed.",
    ...extra,
    answer_text: result.answer_text || "The GitHub CLI request failed.",
  };
}

function compactGhResult(result) {
  const { raw_json, raw_truncated, parsed_json, stderr, ...compact } = result;
  return {
    ...compact,
    raw_json: "",
    raw_truncated: false,
    stderr: stderr ? truncateUtf8(stderr, 1_000).value : "",
  };
}

function buildSearchQuery({ itemType, scope, username, repo, owner, organization }) {
  const typeQualifier = itemType === "pull_requests" ? "is:pr" : "is:issue";
  const scopeQualifier = scopeQualifierFor(scope, username);
  const qualifiers = ["state:open", typeQualifier, scopeQualifier, "archived:false"];
  if (repo) qualifiers.push(`repo:${repo}`);
  else if (organization) qualifiers.push(`org:${organization}`);
  else if (owner) qualifiers.push(`user:${owner}`);
  return qualifiers.join(" ");
}

function scopeQualifierFor(scope, username) {
  if (scope === "assigned") return `assignee:${username}`;
  if (scope === "authored") return `author:${username}`;
  if (scope === "mentioned") return `mentions:${username}`;
  if (scope === "review_requested") return `review-requested:${username}`;
  return `involves:${username}`;
}

function normalizeItemType(value) {
  const normalized = String(value || "").toLowerCase().replaceAll("-", "_");
  if (["pull_request", "pull_requests", "pr", "prs"].includes(normalized)) {
    return "pull_requests";
  }
  return "issues";
}

function normalizeScope(value, itemType) {
  const normalized = String(value || "").toLowerCase().replaceAll("-", "_");
  const allowed = new Set([
    "involved",
    "assigned",
    "authored",
    "mentioned",
    "review_requested",
  ]);
  if (!allowed.has(normalized)) return "involved";
  if (normalized === "review_requested" && itemType !== "pull_requests") return "involved";
  return normalized;
}

function summarizeSearchItem(item) {
  const title = item.title || "";
  return {
    type: item.pull_request ? "pull_request" : "issue",
    repo: repoNameFromApiUrl(item.repository_url),
    number: item.number,
    title,
    spoken_summary: shortSpokenDescription(title),
    url: item.html_url || "",
    author: item.user?.login || "",
    labels: (item.labels || []).map((label) => label.name).filter(Boolean),
    assignees: (item.assignees || []).map((assignee) => assignee.login).filter(Boolean),
    comments: item.comments || 0,
    created_at: item.created_at || "",
    updated_at: item.updated_at || "",
    excerpt: excerpt(item.body || ""),
  };
}

function summarizeContentEntry(entry) {
  return {
    name: entry.name || entry.path?.split("/").pop() || "",
    path: entry.path || "",
    type: entry.type === "dir" || entry.type === "tree" ? "dir" : "file",
    size: entry.size ?? null,
    sha: entry.sha || "",
    url: entry.html_url || "",
  };
}

function summarizeTreeEntry(entry) {
  return {
    name: entry.path?.split("/").pop() || entry.path || "",
    path: entry.path || "",
    type: entry.type === "tree" ? "dir" : "file",
    size: entry.size ?? null,
    sha: entry.sha || "",
    url: "",
  };
}

function summarizeIssue(issue) {
  const title = issue.title || "";
  return {
    type: issue.pull_request ? "pull_request" : "issue",
    repo: repoNameFromApiUrl(issue.repository_url),
    number: issue.number,
    title,
    spoken_summary: shortSpokenDescription(title),
    state: issue.state || "",
    state_reason: issue.state_reason || "",
    url: issue.html_url || "",
    author: issue.user?.login || "",
    labels: (issue.labels || []).map((label) => label.name).filter(Boolean),
    assignees: (issue.assignees || []).map((assignee) => assignee.login).filter(Boolean),
    comments: issue.comments || 0,
    created_at: issue.created_at || "",
    updated_at: issue.updated_at || "",
    closed_at: issue.closed_at || "",
    excerpt: excerpt(issue.body || ""),
  };
}

function compareEntries(left, right) {
  if (left.type !== right.type) return left.type === "dir" ? -1 : 1;
  return left.path.localeCompare(right.path);
}

function formatGithubSummaryAnswer({
  account,
  itemType,
  scope,
  repo,
  owner,
  organization,
  totalCount,
  items,
}) {
  const label = itemType === "pull_requests" ? "open pull requests" : "open issues";
  const scopeLabel = scope.replaceAll("_", " ");
  const location = repo
    ? ` in ${repo}`
    : organization
      ? ` in the ${organization} organization`
      : owner
        ? ` owned by ${owner}`
        : "";

  if (totalCount === 0) {
    return `GitHub shows no ${label}${location} for ${account} matching ${scopeLabel}.`;
  }

  const intro = `GitHub shows ${totalCount} ${label}${location} for ${account} matching ${scopeLabel}. Showing the ${items.length} most recently updated.`;
  const lines = items.map((item) => {
    const labels = item.labels.length > 0 ? ` Labels: ${item.labels.join(", ")}.` : "";
    const assignees =
      item.assignees.length > 0 ? ` Assigned to ${item.assignees.join(", ")}.` : "";
    const excerptText = item.excerpt ? ` ${item.excerpt}` : "";
    const spokenSummary = item.spoken_summary || shortSpokenDescription(item.title);
    return `${spokenSummary}: ${sanitizeVoiceText(item.title)}. Repository ${item.repo}. Updated ${item.updated_at}.${labels}${assignees}${excerptText}`;
  });
  return [intro, ...lines].join("\n");
}

function formatLsAnswer({ repo, path, entries, totalCount, truncated, recursive = false }) {
  const scope = path ? `${repo}/${path}` : repo;
  const mode = recursive ? "recursive tree" : "directory";
  if (entries.length === 0) return `GitHub returned no entries for ${scope}.`;
  const suffix = truncated ? ` Showing ${entries.length} of ${totalCount}.` : "";
  const names = entries.slice(0, 8).map((entry) => `${entry.type === "dir" ? "folder" : "file"} ${entry.path}`);
  return `GitHub returned ${totalCount} entries for the ${mode} ${scope}.${suffix} ${names.join("; ")}.`;
}

function formatCatAnswer({ repo, path, byteLength, returnedBytes, truncated }) {
  const suffix = truncated ? ` Returned ${returnedBytes} of ${byteLength} bytes.` : "";
  return `Read ${path} from ${repo}.${suffix}`;
}

function voiceIssueSummary(issue) {
  const title = String(issue.title || "").trim();
  const body = String(issue.excerpt || "").trim();
  const text = [title, body].filter(Boolean).join(". ");
  return text ? `${text.slice(0, 220)}${text.length > 220 ? "..." : ""}` : "No details provided.";
}

function shortSpokenDescription(value) {
  const normalized = String(value || "")
    .replace(/[`"'“”‘’()[\]{}]/g, " ")
    .replace(/[#/:;,.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "GitHub item";

  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
  ]);
  const words = normalized
    .split(" ")
    .filter((word) => /[a-z0-9]/i.test(word))
    .filter((word) => !stopWords.has(word.toLowerCase()));
  const chosen = (words.length >= 2 ? words : normalized.split(" ")).slice(0, 4);
  return chosen.join(" ") || "GitHub item";
}

function requireConfirmed(confirmed) {
  if (confirmed === true || confirmed === "true") return null;
  return confirmationRequired(
    "Ask Andrew to confirm the exact GitHub issue change before calling this tool with confirmed=true."
  );
}

function appendArrayFields(args, name, values) {
  for (const value of values) {
    args.push("-f", `${name}[]=${value}`);
  }
}

function decodeGitHubContent(body) {
  if (body.encoding !== "base64") return String(body.content || "");
  return Buffer.from(String(body.content || "").replace(/\s+/g, ""), "base64").toString("utf8");
}

function githubContentsEndpoint(repo, path) {
  const suffix = path
    ? `/${path.split("/").map(encodeURIComponent).join("/")}`
    : "";
  return `repos/${encodeRepoName(repo)}/contents${suffix}`;
}

function ghLsCommand({ repo, path, ref }) {
  const target = path ? `${repo}/${path}` : repo;
  return `gh api ${shellWord(githubContentsEndpoint(repo, path))}${ref ? ` -f ref=${shellWord(ref)}` : ""} # ls ${target}`;
}

function ghTreeCommand({ repo, ref }) {
  return `gh api ${shellWord(`repos/${repo}/git/trees/${ref}`)} -f recursive=1`;
}

function ghCatCommand({ repo, path, ref }) {
  return `gh api ${shellWord(githubContentsEndpoint(repo, path))}${ref ? ` -f ref=${shellWord(ref)}` : ""} # cat`;
}

function encodeRepoName(repo) {
  return repo.split("/").map(encodeURIComponent).join("/");
}

function githubSearchFallbackContext({ repo, owner, organization }) {
  if (repo) {
    const fallbackRepo = fallbackRepoName(repo);
    if (fallbackRepo !== repo) return { repo: fallbackRepo, owner: "", organization: "" };
  }

  if (organization) {
    const fallbackOrganization = fallbackGitHubLogin(organization);
    if (fallbackOrganization !== organization) {
      return { repo: "", owner: "", organization: fallbackOrganization };
    }
  }

  if (owner) {
    const fallbackOwner = fallbackGitHubLogin(owner);
    if (fallbackOwner !== owner) return { repo: "", owner: fallbackOwner, organization: "" };
  }

  return null;
}

function githubRepoCandidates(repo) {
  const fallbackRepo = fallbackRepoName(repo);
  return [repo, fallbackRepo].filter((candidate, index, candidates) =>
    candidate && candidates.indexOf(candidate) === index
  );
}

function fallbackRepoName(repo) {
  const [owner, name] = repo.split("/");
  const fallbackOwner = fallbackGitHubLogin(owner);
  const fallbackName = fallbackGitHubLogin(name);
  return `${fallbackOwner}/${fallbackName}`;
}

function fallbackGitHubLogin(value) {
  const login = normalizeString(value);
  if (!login || login.includes("-") || !/[A-Z]/.test(login)) return login;
  return login
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function repoNameFromApiUrl(value) {
  const match = String(value || "").match(/\/repos\/([^/]+\/[^/]+)$/);
  return match?.[1] || "";
}

function normalizeRepo(value) {
  const normalized = normalizeString(value).replace(/^https:\/\/github\.com\//, "");
  const [owner, repo, ...extra] = normalized.split("/");
  if (!owner || !repo || extra.length > 0) {
    throw new Error("repo must be in owner/name format, for example octo-org/example-repo.");
  }
  const fullName = `${owner}/${repo}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new Error("repo contains unsupported characters.");
  }
  return fullName;
}

function normalizePath(value) {
  return normalizeString(value).replace(/^\/+|\/+$/g, "");
}

function normalizeQualifierValue(value) {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("GitHub owner or organization contains unsupported characters.");
  }
  return normalized;
}

function normalizeIssueNumber(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("issue number must be a positive integer.");
  }
  return number;
}

function normalizeRequiredString(value, name, maxLength) {
  const normalized = normalizeString(value);
  if (!normalized) throw new Error(`${name} is required.`);
  if (normalized.length > maxLength) {
    throw new Error(`${name} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function normalizeStringArray(value, name) {
  if (value == null || value === "") return [];
  const values = Array.isArray(value)
    ? value
    : String(value).split(",").map((item) => item.trim());
  const normalized = values.map((item) => normalizeString(item)).filter(Boolean);
  if (normalized.some((item) => item.length > 100)) {
    throw new Error(`${name} contains a value longer than 100 characters.`);
  }
  return normalized;
}

function normalizeState(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (!["open", "closed"].includes(normalized)) {
    throw new Error("state must be open or closed.");
  }
  return normalized;
}

function normalizeOptionalStateReason(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return "";
  if (!["completed", "not_planned"].includes(normalized)) {
    throw new Error("state_reason must be completed or not_planned.");
  }
  return normalized;
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

function excerpt(value) {
  return sanitizeVoiceText(normalizeString(value)).slice(0, 220);
}

function sanitizeVoiceText(value) {
  return String(value || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/#\d+/g, "linked item")
    .replace(/\b(issue|pull request|pr)\s+linked item\b/gi, "$1 reference")
    .replace(/[*_`>~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function utf8ByteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
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

function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
