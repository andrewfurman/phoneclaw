const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

const configs = [
  githubSummaryToolConfig(),
  githubCliLsToolConfig(),
  githubCliCatToolConfig(),
  githubIssueCreateToolConfig(),
  githubIssueUpdateToolConfig(),
];

const tools = [];
for (const toolConfig of configs) {
  tools.push(await upsertTool(toolConfig));
}

const agent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`);
const conversationConfig = structuredClone(agent.conversation_config || {});
const promptConfig = conversationConfig.agent?.prompt || {};
const currentToolIds = promptConfig.tool_ids || [];
const toolIds = unique([
  ...currentToolIds,
  ...tools.map((tool) => tool.id),
]);
const nextPrompt = promptWithGithubFileTools(promptConfig.prompt || "");

delete promptConfig.tools;
conversationConfig.agent = {
  ...(conversationConfig.agent || {}),
  prompt: {
    ...promptConfig,
    prompt: nextPrompt,
    tool_ids: toolIds,
  },
};

const updatedAgent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`, {
  method: "PATCH",
  body: JSON.stringify({
    conversation_config: conversationConfig,
    version_description:
      "Add read-only GitHub repo filter, tree listing, and file content tools",
  }),
});

console.log(
  JSON.stringify(
    {
      ok: true,
      agent_id: updatedAgent.agent_id,
      tool_ids: tools.map((tool) => ({
        id: tool.id,
        name: tool.tool_config?.name,
      })),
      attached_tool_ids: toolIds,
    },
    null,
    2
  )
);

async function upsertTool(toolConfig) {
  const existing = await findToolByName(toolConfig.name);
  if (existing) {
    return requestJson(`${apiBase}/v1/convai/tools/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ tool_config: toolConfig }),
    });
  }

  return requestJson(`${apiBase}/v1/convai/tools`, {
    method: "POST",
    body: JSON.stringify({ tool_config: toolConfig }),
  });
}

async function findToolByName(name) {
  const url = new URL(`${apiBase}/v1/convai/tools`);
  url.searchParams.set("search", name);
  url.searchParams.set("page_size", "100");
  url.searchParams.append("types", "webhook");

  const body = await requestJson(url.toString());
  return (body.tools || []).find((tool) => tool.tool_config?.name === name) || null;
}

function githubSummaryToolConfig() {
  return webhookTool({
    name: "github_summary",
    description:
      "Returns read-only summaries of open GitHub issues or pull requests visible to Andrew Furman's configured GitHub token. Supports optional repo, owner, and organization filters.",
    url: `${workerBaseUrl}/github-summary`,
    required: ["item_type"],
    requestProperties: {
      item_type: stringProperty({
        description:
          "Which GitHub item type to summarize. Use issues for open issues and pull_requests for open pull requests.",
        values: ["issues", "pull_requests"],
      }),
      scope: stringProperty({
        description:
          "How to filter items relative to Andrew. Use involved by default. Use assigned, authored, mentioned, or review_requested when Andrew asks for that narrower view.",
        values: ["involved", "assigned", "authored", "mentioned", "review_requested"],
      }),
      repo: stringProperty({
        description:
          "Optional full repository name in owner/name format, for example octo-org/example-repo. Use this when Andrew asks about a specific repo.",
      }),
      organization: stringProperty({
        description:
          "Optional GitHub organization login, for example octo-org. Use this when Andrew asks about an organization but not a specific repo.",
      }),
      owner: stringProperty({
        description:
          "Optional GitHub owner login. Use repo when a specific repository is known.",
      }),
      max_results: integerProperty({
        description:
          "Maximum number of recent items to return. Use 5 unless Andrew asks for more or fewer.",
      }),
    },
    responseDescription: "Read-only GitHub issue or pull request summary response.",
    responseProperties: {
      ok: booleanProperty("Whether the GitHub summary request succeeded."),
      account: stringProperty({ description: "The GitHub account used for the query." }),
      item_type: stringProperty({
        description: "The item type searched: issues or pull_requests.",
      }),
      scope: stringProperty({ description: "The search scope used." }),
      repo: stringProperty({ description: "Repository filter, if supplied." }),
      organization: stringProperty({
        description: "Organization filter, if supplied.",
      }),
      total_count: integerProperty({
        description: "Total number of matching open items.",
      }),
      returned_count: integerProperty({
        description: "Number of compact items returned.",
      }),
      query: stringProperty({ description: "The GitHub search query used." }),
      source_note: stringProperty({ description: "Notes about the GitHub source." }),
      answer_text: stringProperty({
        description: "A compact spoken summary. Prefer this when answering by voice.",
      }),
      items: arrayProperty({
        description: "Compact GitHub items to summarize for Andrew.",
        itemDescription: "One GitHub issue or pull request.",
        properties: {
          type: stringProperty({ description: "Item type." }),
          repo: stringProperty({ description: "Repository full name." }),
          number: integerProperty({ description: "Issue or pull request number." }),
          title: stringProperty({ description: "Issue or pull request title." }),
          url: stringProperty({ description: "GitHub web URL." }),
          author: stringProperty({ description: "GitHub login of the author." }),
          comments: integerProperty({ description: "Number of comments." }),
          created_at: stringProperty({ description: "Creation timestamp." }),
          updated_at: stringProperty({ description: "Last update timestamp." }),
          excerpt: stringProperty({ description: "Short body excerpt." }),
        },
      }),
    },
  });
}

function githubCliLsToolConfig() {
  return webhookTool({
    name: "github_cli_ls",
    description:
      "Read-only GitHub CLI-style directory/tree listing. Use it to inspect a repo root, a folder, or a recursive folder tree before choosing exact files to read.",
    url: `${workerBaseUrl}/github-cli/ls`,
    required: ["repo"],
    requestProperties: {
      repo: stringProperty({
        description:
          "Full repository name in owner/name format, for example octo-org/example-repo.",
      }),
      path: stringProperty({
        description:
          "Repository-relative folder path. Use an empty string or omit it for the repository root.",
      }),
      ref: stringProperty({
        description:
          "Optional branch, tag, or commit SHA. Omit this to use the repository default branch.",
      }),
      recursive: booleanProperty(
        "Set true to return a recursive tree for the path; set false or omit for one directory."
      ),
      max_entries: integerProperty({
        description: "Maximum entries to return. Use 100 by default, lower for phone calls.",
      }),
    },
    responseDescription: "GitHub directory or tree listing.",
    responseProperties: {
      ok: booleanProperty("Whether the GitHub listing request succeeded."),
      command: stringProperty({ description: "GitHub CLI-style command name." }),
      repo: stringProperty({ description: "Repository full name." }),
      path: stringProperty({ description: "Requested path." }),
      ref: stringProperty({ description: "Requested or resolved ref." }),
      recursive: booleanProperty("Whether the result is recursive."),
      total_count: integerProperty({ description: "Total matching entries." }),
      returned_count: integerProperty({ description: "Returned entries." }),
      truncated: booleanProperty("Whether the response was truncated."),
      gh_equivalent: stringProperty({
        description: "Closest GitHub CLI command equivalent.",
      }),
      answer_text: stringProperty({
        description: "Compact spoken summary. Prefer this for quick answers.",
      }),
      entries: arrayProperty({
        description: "Directory or tree entries.",
        itemDescription: "One file or directory.",
        properties: githubEntryProperties(),
      }),
    },
  });
}

function githubCliCatToolConfig() {
  return webhookTool({
    name: "github_cli_cat",
    description:
      "Read-only GitHub CLI-style file reader. Use it after github_cli_ls identifies an exact file path. Returns the file contents.",
    url: `${workerBaseUrl}/github-cli/cat`,
    required: ["repo", "path"],
    requestProperties: {
      repo: stringProperty({
        description:
          "Full repository name in owner/name format, for example octo-org/example-repo.",
      }),
      path: stringProperty({
        description: "Repository-relative file path to read.",
      }),
      ref: stringProperty({
        description:
          "Optional branch, tag, or commit SHA. Omit this to use the repository default branch.",
      }),
      max_bytes: integerProperty({
        description:
          "Maximum file bytes to return. Use 20000 for phone summaries unless Andrew asks for the full file.",
      }),
    },
    responseDescription: "GitHub file content response.",
    responseProperties: {
      ok: booleanProperty("Whether the GitHub file request succeeded."),
      command: stringProperty({ description: "GitHub CLI-style command name." }),
      repo: stringProperty({ description: "Repository full name." }),
      path: stringProperty({ description: "Requested file path." }),
      ref: stringProperty({ description: "Requested ref." }),
      name: stringProperty({ description: "File name." }),
      sha: stringProperty({ description: "Git blob SHA." }),
      size_bytes: integerProperty({ description: "Original file size in bytes." }),
      returned_bytes: integerProperty({ description: "Returned content size in bytes." }),
      truncated: booleanProperty("Whether returned content was truncated."),
      encoding: stringProperty({ description: "Returned text encoding." }),
      gh_equivalent: stringProperty({
        description: "Closest GitHub CLI command equivalent.",
      }),
      answer_text: stringProperty({
        description: "Compact spoken summary. Prefer this before quoting file content.",
      }),
      content: stringProperty({
        description: "File contents, possibly truncated according to max_bytes.",
      }),
    },
  });
}

function githubIssueCreateToolConfig() {
  return webhookTool({
    name: "github_issue_create",
    description:
      "Creates a GitHub issue after Andrew explicitly confirms the exact repository, title, and body. This is a write action.",
    url: `${workerBaseUrl}/github-issues/create`,
    required: ["repo", "title", "confirmed"],
    requestProperties: {
      repo: stringProperty({
        description:
          "Full repository name in owner/name format, for example octo-org/example-repo.",
      }),
      title: stringProperty({
        description: "Issue title. Confirm this exact title with Andrew before use.",
      }),
      body: stringProperty({
        description: "Issue body in Markdown. Confirm the key content with Andrew before use.",
      }),
      labels: stringProperty({
        description:
          "Optional comma-separated GitHub labels. Only use labels Andrew asks for.",
      }),
      assignees: stringProperty({
        description:
          "Optional comma-separated GitHub usernames to assign. Only use assignees Andrew asks for.",
      }),
      confirmed: booleanProperty(
        "Must be true only after Andrew verbally confirms the exact issue creation."
      ),
    },
    responseDescription: "GitHub issue creation response.",
    responseProperties: githubIssueWriteResponseProperties(),
  });
}

function githubIssueUpdateToolConfig() {
  return webhookTool({
    name: "github_issue_update",
    description:
      "Updates an existing GitHub issue after Andrew explicitly confirms the exact repository, issue number, and change. This is a write action.",
    url: `${workerBaseUrl}/github-issues/update`,
    required: ["repo", "issue_number", "confirmed"],
    requestProperties: {
      repo: stringProperty({
        description:
          "Full repository name in owner/name format, for example octo-org/example-repo.",
      }),
      issue_number: integerProperty({
        description: "Issue number to update.",
      }),
      title: stringProperty({
        description: "Optional replacement issue title. Confirm before use.",
      }),
      body: stringProperty({
        description: "Optional replacement issue body in Markdown. Confirm before use.",
      }),
      state: stringProperty({
        description: "Optional issue state. Use open or closed only when Andrew asks.",
        values: ["open", "closed"],
      }),
      state_reason: stringProperty({
        description:
          "Optional close reason. Use completed or not_planned only when closing an issue.",
        values: ["completed", "not_planned"],
      }),
      labels: stringProperty({
        description:
          "Optional comma-separated replacement GitHub labels. Only use labels Andrew asks for.",
      }),
      assignees: stringProperty({
        description:
          "Optional comma-separated replacement GitHub usernames. Only use assignees Andrew asks for.",
      }),
      confirmed: booleanProperty(
        "Must be true only after Andrew verbally confirms the exact issue update."
      ),
    },
    responseDescription: "GitHub issue update response.",
    responseProperties: githubIssueWriteResponseProperties(),
  });
}

function webhookTool({
  name,
  description,
  url,
  required,
  requestProperties,
  responseDescription,
  responseProperties,
}) {
  return {
    type: "webhook",
    name,
    description,
    response_timeout_secs: 15,
    disable_interruptions: false,
    force_pre_tool_speech: false,
    pre_tool_speech: "auto",
    assignments: [],
    tool_call_sound: null,
    tool_call_sound_behavior: "auto",
    tool_error_handling_mode: "auto",
    dynamic_variables: {
      dynamic_variable_placeholders: {},
    },
    execution_mode: "immediate",
    api_schema: {
      request_headers: {
        Authorization: `Bearer ${toolToken}`,
      },
      url,
      method: "POST",
      path_params_schema: {},
      query_params_schema: null,
      request_body_schema: {
        type: "object",
        required,
        description: "",
        properties: requestProperties,
      },
      response_body_schema: {
        type: "object",
        required: [],
        description: responseDescription,
        properties: responseProperties,
      },
      content_type: "application/json",
      auth_resolved_params: [],
      auth_connection: null,
    },
  };
}

function githubEntryProperties() {
  return {
    type: stringProperty({ description: "Entry type, usually dir or file." }),
    name: stringProperty({ description: "Entry name." }),
    path: stringProperty({ description: "Repository-relative path." }),
    size: integerProperty({ description: "Size in bytes for files, if available." }),
    sha: stringProperty({ description: "Git SHA." }),
    url: stringProperty({ description: "GitHub web URL when available." }),
  };
}

function githubIssueWriteResponseProperties() {
  return {
    ok: booleanProperty("Whether the GitHub write succeeded."),
    action: stringProperty({ description: "Action performed: created or updated." }),
    status: stringProperty({ description: "Error or confirmation status when not ok." }),
    message: stringProperty({ description: "Error or confirmation message when present." }),
    repo: stringProperty({ description: "Repository full name." }),
    answer_text: stringProperty({
      description: "Compact spoken summary. Prefer this after successful writes.",
    }),
    issue: objectProperty({
      description: "Created or updated GitHub issue.",
      properties: {
        type: stringProperty({ description: "Item type." }),
        repo: stringProperty({ description: "Repository full name." }),
        number: integerProperty({ description: "Issue number." }),
        title: stringProperty({ description: "Issue title." }),
        state: stringProperty({ description: "Issue state." }),
        state_reason: stringProperty({ description: "Issue state reason." }),
        url: stringProperty({ description: "GitHub web URL." }),
        author: stringProperty({ description: "GitHub login of the author." }),
        labels: stringArrayProperty("Issue labels."),
        assignees: stringArrayProperty("Issue assignee GitHub logins."),
        comments: integerProperty({ description: "Number of comments." }),
        created_at: stringProperty({ description: "Creation timestamp." }),
        updated_at: stringProperty({ description: "Last update timestamp." }),
        closed_at: stringProperty({ description: "Closed timestamp, if closed." }),
        excerpt: stringProperty({ description: "Short body excerpt." }),
      },
    }),
  };
}

function stringProperty({ description, values = null }) {
  return {
    type: "string",
    description,
    enum: values,
    nullable: false,
    is_system_provided: false,
    dynamic_variable: "",
    allowed_values_dynamic_variable: "",
    constant_value: "",
    is_omitted: false,
  };
}

function integerProperty({ description }) {
  return {
    type: "integer",
    description,
    enum: null,
    nullable: false,
    is_system_provided: false,
    dynamic_variable: "",
    allowed_values_dynamic_variable: "",
    constant_value: "",
    is_omitted: false,
  };
}

function booleanProperty(description) {
  return {
    type: "boolean",
    description,
    enum: null,
    nullable: false,
    is_system_provided: false,
    dynamic_variable: "",
    allowed_values_dynamic_variable: "",
    constant_value: "",
    is_omitted: false,
  };
}

function arrayProperty({ description, itemDescription, properties }) {
  return {
    type: "array",
    description,
    items: {
      type: "object",
      required: [],
      description: itemDescription,
      properties,
    },
    dynamic_variable: "",
    constant_value: null,
    is_omitted: false,
  };
}

function stringArrayProperty(description) {
  return {
    type: "array",
    description,
    items: {
      type: "string",
      description: "Array item.",
      enum: null,
      nullable: false,
      is_system_provided: false,
      dynamic_variable: "",
      allowed_values_dynamic_variable: "",
      constant_value: "",
      is_omitted: false,
    },
    dynamic_variable: "",
    constant_value: null,
    is_omitted: false,
  };
}

function objectProperty({ description, properties }) {
  return {
    type: "object",
    required: [],
    description,
    properties,
  };
}

function promptWithGithubFileTools(currentPrompt) {
  const section = `GitHub capability:
- You have webhook tools named github_summary, github_cli_ls, github_cli_cat, github_issue_create, and github_issue_update.
- Use github_summary when Andrew asks how many open GitHub issues or pull requests he has, what they are about, what needs attention, or asks for quick GitHub triage.
- Use item_type="issues" for issue questions and item_type="pull_requests" for pull request questions.
- Use scope="involved" by default. Use scope="assigned", "authored", "mentioned", or "review_requested" only when Andrew asks for that narrower view.
- When Andrew names a specific repository, pass repo in owner/name format, for example repo="octo-org/example-repo". When he names only an organization, pass organization, for example organization="octo-org".
- Use github_cli_ls to inspect a repository root, a folder, or a recursive folder tree. Use path="" or omit path for the root. Set recursive=true when Andrew asks for the full tree of a folder.
- Use github_cli_cat only when you know the exact file path. If the repo, path, or branch/ref is unclear, ask a short clarifying question.
- Use github_issue_create only after Andrew explicitly confirms the exact repo, title, and body. Set confirmed=true only after that confirmation.
- Use github_issue_update only after Andrew explicitly confirms the exact repo, issue number, and requested change. Set confirmed=true only after that confirmation.
- The GitHub issue tools can create and update issues only. They cannot merge, approve, push code, or edit files.
- If a private repo returns 403, 404, or a GitHub validation failure, say the configured token may not have access to that repo, org approval, or Contents read permission.`;
  const readMarker = "\n\nGitHub read capability:";
  const capabilityMarker = "\n\nGitHub capability:";
  const readIndex = currentPrompt.indexOf(readMarker);
  const capabilityIndex = currentPrompt.indexOf(capabilityMarker);
  const index = capabilityIndex >= 0 ? capabilityIndex : readIndex;
  if (index >= 0) {
    return `${currentPrompt.slice(0, index)}\n\n${section}`;
  }

  return `${currentPrompt.trim()}\n\n${section}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const parsed = parseMaybeJson(text);

  if (!response.ok) {
    throw new Error(`ElevenLabs request failed (${response.status}): ${text}`);
  }

  return parsed;
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
