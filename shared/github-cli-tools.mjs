const GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_MAX_ENTRIES = 100;
const MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 120_000;
const MAX_BYTES = 250_000;

export async function githubCliLs({
  githubToken,
  repo,
  path = "",
  ref,
  recursive = false,
  maxEntries = DEFAULT_MAX_ENTRIES,
  fetchImpl = fetch,
}) {
  if (!githubToken) {
    return missingTokenResponse();
  }

  const normalizedRepo = normalizeRepo(repo);
  const normalizedPath = normalizePath(path);
  const normalizedRef = normalizeOptionalRef(ref);
  const limit = clampInteger(maxEntries, 1, MAX_ENTRIES);

  if (toBoolean(recursive)) {
    return githubCliTree({
      githubToken,
      repo: normalizedRepo,
      path: normalizedPath,
      ref: normalizedRef,
      maxEntries: limit,
      fetchImpl,
    });
  }

  const endpointPath = `/repos/${encodeRepoPath(normalizedRepo)}/contents${contentPathSuffix(
    normalizedPath
  )}`;
  const url = githubUrl(endpointPath);
  if (normalizedRef) url.searchParams.set("ref", normalizedRef);

  const response = await fetchImpl(url.toString(), {
    headers: githubHeaders(githubToken),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return githubFailure({
      status: "github_ls_failed",
      githubStatus: response.status,
      message: body.message || "GitHub contents request failed.",
      repo: normalizedRepo,
      path: normalizedPath,
      ref: normalizedRef,
      ghEquivalent: ghLsCommand({ repo: normalizedRepo, path: normalizedPath, ref: normalizedRef }),
    });
  }

  if (!Array.isArray(body)) {
    return {
      ok: false,
      status: "path_is_not_directory",
      message: "The requested GitHub path is not a directory. Use github_cli_cat for files.",
      repo: normalizedRepo,
      path: normalizedPath,
      ref: normalizedRef || null,
      gh_equivalent: ghLsCommand({ repo: normalizedRepo, path: normalizedPath, ref: normalizedRef }),
      entries: [],
    };
  }

  const entries = body.map(summarizeContentEntry).sort(compareEntries);
  const limitedEntries = entries.slice(0, limit);

  return {
    ok: true,
    command: "ls",
    repo: normalizedRepo,
    path: normalizedPath,
    ref: normalizedRef || null,
    recursive: false,
    total_count: entries.length,
    returned_count: limitedEntries.length,
    truncated: entries.length > limitedEntries.length,
    gh_equivalent: ghLsCommand({ repo: normalizedRepo, path: normalizedPath, ref: normalizedRef }),
    entries: limitedEntries,
    answer_text: formatLsAnswer({
      repo: normalizedRepo,
      path: normalizedPath,
      entries: limitedEntries,
      totalCount: entries.length,
      truncated: entries.length > limitedEntries.length,
    }),
  };
}

export async function githubCliCat({
  githubToken,
  repo,
  path,
  ref,
  maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl = fetch,
}) {
  if (!githubToken) {
    return missingTokenResponse();
  }

  const normalizedRepo = normalizeRepo(repo);
  const normalizedPath = normalizePath(path);
  const normalizedRef = normalizeOptionalRef(ref);
  const byteLimit = clampInteger(maxBytes, 1, MAX_BYTES);

  if (!normalizedPath) {
    return {
      ok: false,
      status: "missing_path",
      message: "A file path is required.",
      repo: normalizedRepo,
      path: normalizedPath,
      ref: normalizedRef || null,
    };
  }

  const endpointPath = `/repos/${encodeRepoPath(normalizedRepo)}/contents${contentPathSuffix(
    normalizedPath
  )}`;
  const url = githubUrl(endpointPath);
  if (normalizedRef) url.searchParams.set("ref", normalizedRef);

  const response = await fetchImpl(url.toString(), {
    headers: githubHeaders(githubToken),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return githubFailure({
      status: "github_cat_failed",
      githubStatus: response.status,
      message: body.message || "GitHub contents request failed.",
      repo: normalizedRepo,
      path: normalizedPath,
      ref: normalizedRef,
      ghEquivalent: ghCatCommand({ repo: normalizedRepo, path: normalizedPath, ref: normalizedRef }),
    });
  }

  if (Array.isArray(body) || body.type !== "file") {
    return {
      ok: false,
      status: "path_is_not_file",
      message: "The requested GitHub path is not a file. Use github_cli_ls for directories.",
      repo: normalizedRepo,
      path: normalizedPath,
      ref: normalizedRef || null,
      gh_equivalent: ghCatCommand({ repo: normalizedRepo, path: normalizedPath, ref: normalizedRef }),
      content: "",
    };
  }

  const content = await contentTextFromResponse({
    body,
    url,
    githubToken,
    fetchImpl,
  });
  const truncatedContent = truncateUtf8(content, byteLimit);

  return {
    ok: true,
    command: "cat",
    repo: normalizedRepo,
    path: normalizedPath,
    ref: normalizedRef || null,
    name: body.name || "",
    sha: body.sha || "",
    size_bytes: body.size ?? utf8ByteLength(content),
    returned_bytes: utf8ByteLength(truncatedContent.value),
    truncated: truncatedContent.truncated,
    encoding: "utf-8",
    gh_equivalent: ghCatCommand({ repo: normalizedRepo, path: normalizedPath, ref: normalizedRef }),
    content: truncatedContent.value,
    answer_text: formatCatAnswer({
      repo: normalizedRepo,
      path: normalizedPath,
      byteLength: body.size ?? utf8ByteLength(content),
      returnedBytes: utf8ByteLength(truncatedContent.value),
      truncated: truncatedContent.truncated,
    }),
  };
}

async function githubCliTree({
  githubToken,
  repo,
  path,
  ref,
  maxEntries,
  fetchImpl,
}) {
  const resolvedRef = ref || (await fetchDefaultBranch({ githubToken, repo, fetchImpl }));
  const endpointPath = `/repos/${encodeRepoPath(repo)}/git/trees/${encodeURIComponent(
    resolvedRef
  )}`;
  const url = githubUrl(endpointPath);
  url.searchParams.set("recursive", "1");

  const response = await fetchImpl(url.toString(), {
    headers: githubHeaders(githubToken),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return githubFailure({
      status: "github_tree_failed",
      githubStatus: response.status,
      message: body.message || "GitHub tree request failed.",
      repo,
      path,
      ref: resolvedRef,
      ghEquivalent: ghTreeCommand({ repo, ref: resolvedRef }),
    });
  }

  const prefix = path ? `${path}/` : "";
  const entries = (body.tree || [])
    .filter((entry) => !path || entry.path === path || entry.path.startsWith(prefix))
    .filter((entry) => entry.path !== path)
    .map(summarizeTreeEntry)
    .sort(compareEntries);
  const limitedEntries = entries.slice(0, maxEntries);

  return {
    ok: true,
    command: "ls",
    repo,
    path,
    ref: resolvedRef,
    recursive: true,
    total_count: entries.length,
    returned_count: limitedEntries.length,
    truncated: Boolean(body.truncated) || entries.length > limitedEntries.length,
    github_tree_truncated: Boolean(body.truncated),
    gh_equivalent: ghTreeCommand({ repo, ref: resolvedRef }),
    entries: limitedEntries,
    answer_text: formatLsAnswer({
      repo,
      path,
      entries: limitedEntries,
      totalCount: entries.length,
      truncated: Boolean(body.truncated) || entries.length > limitedEntries.length,
      recursive: true,
    }),
  };
}

async function fetchDefaultBranch({ githubToken, repo, fetchImpl }) {
  const url = githubUrl(`/repos/${encodeRepoPath(repo)}`);
  const response = await fetchImpl(url.toString(), {
    headers: githubHeaders(githubToken),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.default_branch) {
    throw new Error(body.message || "Could not resolve the repository default branch.");
  }
  return body.default_branch;
}

async function contentTextFromResponse({ body, url, githubToken, fetchImpl }) {
  if (body.encoding === "base64" && body.content) {
    return decodeBase64(body.content);
  }

  const rawResponse = await fetchImpl(url.toString(), {
    headers: {
      ...githubHeaders(githubToken),
      accept: "application/vnd.github.raw",
    },
  });

  if (!rawResponse.ok) {
    throw new Error(`GitHub raw content request failed with ${rawResponse.status}.`);
  }

  return rawResponse.text();
}

function githubHeaders(githubToken) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${githubToken}`,
    "user-agent": "phoneclaw/0.1 github-cli-tools",
    "x-github-api-version": "2022-11-28",
  };
}

function githubUrl(path) {
  return new URL(`${GITHUB_API_BASE}${path}`);
}

function missingTokenResponse() {
  return {
    ok: false,
    status: "github_auth_not_configured",
    message: "GITHUB_READ_TOKEN is not configured.",
    entries: [],
  };
}

function githubFailure({ status, githubStatus, message, repo, path, ref, ghEquivalent }) {
  return {
    ok: false,
    status,
    github_status: githubStatus,
    message,
    repo,
    path,
    ref: ref || null,
    gh_equivalent: ghEquivalent,
    entries: [],
  };
}

function summarizeContentEntry(entry) {
  return {
    type: normalizeGithubType(entry.type),
    name: entry.name || "",
    path: entry.path || "",
    size: entry.size ?? null,
    sha: entry.sha || "",
    url: entry.html_url || "",
  };
}

function summarizeTreeEntry(entry) {
  return {
    type: entry.type === "tree" ? "dir" : entry.type === "blob" ? "file" : entry.type,
    name: entry.path?.split("/").at(-1) || entry.path || "",
    path: entry.path || "",
    size: entry.size ?? null,
    sha: entry.sha || "",
    url: "",
  };
}

function normalizeGithubType(value) {
  if (value === "dir") return "dir";
  if (value === "file") return "file";
  return String(value || "");
}

function compareEntries(left, right) {
  if (left.type !== right.type) {
    if (left.type === "dir") return -1;
    if (right.type === "dir") return 1;
  }
  return left.path.localeCompare(right.path);
}

function formatLsAnswer({ repo, path, entries, totalCount, truncated, recursive = false }) {
  const location = path ? `${repo}/${path}` : repo;
  const mode = recursive ? "recursive tree" : "directory";
  const intro = `GitHub returned ${totalCount} entries for the ${mode} at ${location}.`;
  const suffix = truncated ? " The response was truncated; narrow the path if needed." : "";
  const preview = entries
    .slice(0, 12)
    .map((entry) => `${entry.type === "dir" ? "dir" : "file"} ${entry.path}`)
    .join("; ");
  return preview ? `${intro} ${preview}.${suffix}` : `${intro}${suffix}`;
}

function formatCatAnswer({ repo, path, byteLength, returnedBytes, truncated }) {
  const suffix = truncated
    ? ` Returned the first ${returnedBytes} bytes because of the tool limit.`
    : "";
  return `GitHub returned ${byteLength} bytes from ${repo}/${path}.${suffix}`;
}

function ghLsCommand({ repo, path, ref }) {
  const apiPath = `repos/${repo}/contents${contentPathSuffix(path)}`;
  const refArg = ref ? ` -f ref=${shellQuote(ref)}` : "";
  return `gh api --method GET ${shellQuote(apiPath)}${refArg}`;
}

function ghTreeCommand({ repo, ref }) {
  return `gh api --method GET ${shellQuote(`repos/${repo}/git/trees/${ref}`)} -f recursive=1`;
}

function ghCatCommand({ repo, path, ref }) {
  const apiPath = `repos/${repo}/contents${contentPathSuffix(path)}`;
  const refArg = ref ? ` -f ref=${shellQuote(ref)}` : "";
  return `gh api --method GET ${shellQuote(apiPath)}${refArg} --jq .content | base64 --decode`;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function contentPathSuffix(path) {
  return path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
}

function encodeRepoPath(repo) {
  return repo.split("/").map(encodeURIComponent).join("/");
}

function normalizeRepo(value) {
  const normalized = String(value || "").trim().replace(/^https:\/\/github\.com\//, "");
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
  const normalized = String(value || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return "";

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("path must be a repository-relative path without . or .. segments.");
  }

  return segments.join("/");
}

function normalizeOptionalRef(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (normalized.includes("..") || /[\s~^:?*[\\]/.test(normalized)) {
    throw new Error("ref contains unsupported characters.");
  }
  return normalized;
}

function decodeBase64(value) {
  const normalized = String(value || "").replace(/\s+/g, "");
  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalized, "base64").toString("utf8");
  }

  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function truncateUtf8(value, maxBytes) {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) {
    return { value, truncated: false };
  }

  return {
    value: new TextDecoder().decode(encoded.slice(0, maxBytes)),
    truncated: true,
  };
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value || "")).byteLength;
}

function toBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function clampInteger(value, min, max) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}
