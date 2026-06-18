const GITHUB_API_BASE = "https://api.github.com";

export async function githubSummary({
  itemType = "issues",
  scope = "involved",
  maxResults = 5,
  githubToken,
  username,
  repo,
  owner,
  organization,
  org,
  fetchImpl = fetch,
}) {
  if (!githubToken) {
    return {
      ok: false,
      status: "github_auth_not_configured",
      message: "GITHUB_READ_TOKEN is not configured.",
      items: [],
    };
  }

  const normalizedType = normalizeItemType(itemType);
  const normalizedScope = normalizeScope(scope, normalizedType);
  const limit = clampInteger(maxResults, 1, 8);
  const account = username || (await fetchAuthenticatedUsername(githubToken, fetchImpl));
  const normalizedRepo = repo ? normalizeRepo(repo) : "";
  const normalizedOwner = owner ? normalizeQualifierValue(owner) : "";
  const normalizedOrg = normalizeQualifierValue(organization || org || "");
  const query = buildSearchQuery({
    itemType: normalizedType,
    scope: normalizedScope,
    username: account,
    repo: normalizedRepo,
    owner: normalizedOwner,
    organization: normalizedOrg,
  });

  const url = new URL(`${GITHUB_API_BASE}/search/issues`);
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(limit));

  const response = await fetchImpl(url.toString(), {
    headers: githubHeaders(githubToken),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      status: "github_search_failed",
      github_status: response.status,
      message: body.message || "GitHub search failed.",
      query,
      items: [],
    };
  }

  const items = (body.items || []).map(summarizeSearchItem);
  return {
    ok: true,
    account,
    item_type: normalizedType,
    scope: normalizedScope,
    repo: normalizedRepo || null,
    owner: normalizedOwner || null,
    organization: normalizedOrg || null,
    total_count: body.total_count || 0,
    returned_count: items.length,
    query,
    source_note:
      "Results come from GitHub issue search over repositories visible to the configured read token.",
    items,
    answer_text: formatGithubAnswer({
      account,
      itemType: normalizedType,
      scope: normalizedScope,
      repo: normalizedRepo,
      owner: normalizedOwner,
      organization: normalizedOrg,
      totalCount: body.total_count || 0,
      items,
    }),
  };
}

async function fetchAuthenticatedUsername(githubToken, fetchImpl) {
  const response = await fetchImpl(`${GITHUB_API_BASE}/user`, {
    headers: githubHeaders(githubToken),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.login) {
    throw new Error(body.message || "Could not resolve GitHub username.");
  }

  return body.login;
}

function githubHeaders(githubToken) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${githubToken}`,
    "user-agent": "phoneclaw/0.1 github-summary",
    "x-github-api-version": "2022-11-28",
  };
}

function buildSearchQuery({ itemType, scope, username, repo, owner, organization }) {
  const typeQualifier = itemType === "pull_requests" ? "is:pr" : "is:issue";
  const scopeQualifier = scopeQualifierFor(scope, username);
  const qualifiers = ["state:open", typeQualifier, scopeQualifier, "archived:false"];

  if (repo) {
    qualifiers.push(`repo:${repo}`);
  } else if (organization) {
    qualifiers.push(`org:${organization}`);
  } else if (owner) {
    qualifiers.push(`user:${owner}`);
  }

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
  if (normalized === "review_requested" && itemType !== "pull_requests") {
    return "involved";
  }
  return normalized;
}

function summarizeSearchItem(item) {
  return {
    type: item.pull_request ? "pull_request" : "issue",
    repo: repoNameFromApiUrl(item.repository_url),
    number: item.number,
    title: item.title || "",
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

function repoNameFromApiUrl(value) {
  const match = String(value || "").match(/\/repos\/([^/]+\/[^/]+)$/);
  return match?.[1] || "";
}

function formatGithubAnswer({
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
  const lines = items.map((item, index) => {
    const labels = item.labels.length > 0 ? ` Labels: ${item.labels.join(", ")}.` : "";
    const assignees =
      item.assignees.length > 0 ? ` Assigned to ${item.assignees.join(", ")}.` : "";
    const excerptText = item.excerpt ? ` ${item.excerpt}` : "";
    return `${index + 1}. ${item.repo} #${item.number}: ${item.title}. Updated ${item.updated_at}.${labels}${assignees}${excerptText}`;
  });

  return [intro, ...lines].join("\n");
}

function excerpt(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 220);
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

function normalizeQualifierValue(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("GitHub owner or organization contains unsupported characters.");
  }
  return normalized;
}

function clampInteger(value, min, max) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}
