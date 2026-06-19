const GITHUB_API_BASE = "https://api.github.com";

export async function githubIssueCreate({
  githubToken,
  repo,
  title,
  body = "",
  labels,
  assignees,
  confirmed,
  fetchImpl = fetch,
}) {
  const confirmation = requireConfirmed(confirmed);
  if (confirmation) return confirmation;

  if (!githubToken) return missingWriteTokenResponse();

  const normalizedRepo = normalizeRepo(repo);
  const normalizedTitle = normalizeRequiredString(title, "title", 256);
  const payload = {
    title: normalizedTitle,
    body: String(body || ""),
  };

  const normalizedLabels = normalizeStringArray(labels, "labels");
  const normalizedAssignees = normalizeStringArray(assignees, "assignees");
  if (normalizedLabels.length > 0) payload.labels = normalizedLabels;
  if (normalizedAssignees.length > 0) payload.assignees = normalizedAssignees;

  const response = await fetchImpl(
    `${GITHUB_API_BASE}/repos/${encodeRepoPath(normalizedRepo)}/issues`,
    {
      method: "POST",
      headers: githubHeaders(githubToken),
      body: JSON.stringify(payload),
    }
  );
  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    return githubIssueFailure({
      status: "github_issue_create_failed",
      githubStatus: response.status,
      message: responseBody.message || "GitHub issue creation failed.",
      repo: normalizedRepo,
    });
  }

  const issue = summarizeIssue(responseBody);
  return {
    ok: true,
    action: "created",
    repo: normalizedRepo,
    issue,
    answer_text: `Created issue #${issue.number} in ${normalizedRepo}: ${issue.title}.`,
  };
}

export async function githubIssueUpdate({
  githubToken,
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
  fetchImpl = fetch,
}) {
  const confirmation = requireConfirmed(confirmed);
  if (confirmation) return confirmation;

  if (!githubToken) return missingWriteTokenResponse();

  const normalizedRepo = normalizeRepo(repo);
  const normalizedNumber = normalizeIssueNumber(issueNumber || number);
  const payload = {};

  if (title !== undefined) {
    payload.title = normalizeRequiredString(title, "title", 256);
  }

  if (body !== undefined) {
    payload.body = String(body);
  }

  if (state !== undefined) {
    payload.state = normalizeState(state);
  }

  const normalizedStateReason = normalizeOptionalStateReason(stateReason || state_reason);
  if (normalizedStateReason) {
    payload.state_reason = normalizedStateReason;
  }

  if (labels !== undefined) {
    payload.labels = normalizeStringArray(labels, "labels");
  }

  if (assignees !== undefined) {
    payload.assignees = normalizeStringArray(assignees, "assignees");
  }

  if (Object.keys(payload).length === 0) {
    return {
      ok: false,
      status: "missing_update_fields",
      message:
        "Provide at least one issue field to update: title, body, state, labels, or assignees.",
      repo: normalizedRepo,
      issue_number: normalizedNumber,
    };
  }

  const response = await fetchImpl(
    `${GITHUB_API_BASE}/repos/${encodeRepoPath(normalizedRepo)}/issues/${normalizedNumber}`,
    {
      method: "PATCH",
      headers: githubHeaders(githubToken),
      body: JSON.stringify(payload),
    }
  );
  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    return githubIssueFailure({
      status: "github_issue_update_failed",
      githubStatus: response.status,
      message: responseBody.message || "GitHub issue update failed.",
      repo: normalizedRepo,
      issueNumber: normalizedNumber,
    });
  }

  const issue = summarizeIssue(responseBody);
  return {
    ok: true,
    action: "updated",
    repo: normalizedRepo,
    issue,
    answer_text: `Updated issue #${issue.number} in ${normalizedRepo}: ${issue.title}.`,
  };
}

function requireConfirmed(confirmed) {
  if (confirmed === true || confirmed === "true") return null;

  return {
    ok: false,
    status: "confirmation_required",
    message:
      "Ask Andrew to confirm the exact GitHub issue change before calling this tool with confirmed=true.",
  };
}

function missingWriteTokenResponse() {
  return {
    ok: false,
    status: "github_write_auth_not_configured",
    message: "GITHUB_WRITE_TOKEN is not configured.",
  };
}

function githubIssueFailure({ status, githubStatus, message, repo, issueNumber }) {
  return {
    ok: false,
    status,
    github_status: githubStatus,
    message,
    repo,
    issue_number: issueNumber || null,
  };
}

function summarizeIssue(issue) {
  return {
    type: issue.pull_request ? "pull_request" : "issue",
    repo: repoNameFromApiUrl(issue.repository_url),
    number: issue.number,
    title: issue.title || "",
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

function githubHeaders(githubToken) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${githubToken}`,
    "content-type": "application/json",
    "user-agent": "phoneclaw/0.1 github-issues",
    "x-github-api-version": "2022-11-28",
  };
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

function normalizeIssueNumber(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("issue number must be a positive integer.");
  }
  return number;
}

function normalizeRequiredString(value, name, maxLength) {
  const normalized = String(value || "").trim();
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
    : String(value)
        .split(",")
        .map((item) => item.trim());

  const normalized = values
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  if (normalized.some((item) => item.length > 100)) {
    throw new Error(`${name} contains a value longer than 100 characters.`);
  }

  return normalized;
}

function normalizeState(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!["open", "closed"].includes(normalized)) {
    throw new Error("state must be open or closed.");
  }
  return normalized;
}

function normalizeOptionalStateReason(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (!["completed", "not_planned"].includes(normalized)) {
    throw new Error("state_reason must be completed or not_planned.");
  }
  return normalized;
}

function repoNameFromApiUrl(value) {
  const match = String(value || "").match(/\/repos\/([^/]+\/[^/]+)$/);
  return match?.[1] || "";
}

function encodeRepoPath(repo) {
  return repo.split("/").map(encodeURIComponent).join("/");
}

function excerpt(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 220);
}
