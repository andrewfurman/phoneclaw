const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;
const maxConversationDurationSeconds = clampInteger(
  process.env.ELEVENLABS_MAX_CONVERSATION_DURATION_SECONDS,
  60,
  7_200,
  7_200
);

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

await verifyWorkerToolToken();

const configs = [
  webSearchToolConfig(),
  githubSummaryToolConfig(),
  githubCliLsToolConfig(),
  githubCliCatToolConfig(),
  githubIssueCreateToolConfig(),
  githubIssueUpdateToolConfig(),
  himalayaEmailListToolConfig(),
  himalayaEmailReadToolConfig(),
  himalayaEmailArchiveToolConfig(),
  himalayaDraftCreateToolConfig(),
  himalayaDraftReplyToolConfig(),
  himalayaEmailForwardToolConfig(),
  createReplyAllDraftToolConfig(),
  createForwardDraftToolConfig(),
  himalayaEmailSendToolConfig(),
  otterSpeechesListToolConfig(),
  otterSpeechGetToolConfig(),
  otterSpeechSearchToolConfig(),
  githubCliCommonToolConfig(),
  rssListFeedsToolConfig(),
  rssRecentEntriesToolConfig(),
  rssSearchEntriesToolConfig(),
  rssGetArticleTextToolConfig(),
  rssRefreshFeedsToolConfig(),
  conversationHistorySearchToolConfig(),
  conversationHistoryGetToolConfig(),
  claudeCodeToolConfig(),
];
const obsoleteToolNames = [
  "himalaya_email_count",
];

const tools = [];
for (const toolConfig of configs) {
  tools.push(await upsertTool(toolConfig));
}

const obsoleteTools = [];
for (const name of obsoleteToolNames) {
  const obsoleteTool = await findToolByName(name);
  if (obsoleteTool) obsoleteTools.push(obsoleteTool);
}

const agent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`);
const conversationConfig = structuredClone(agent.conversation_config || {});
const promptConfig = conversationConfig.agent?.prompt || {};
const {
  tools: _legacyPromptTools,
  built_in_tools: currentBuiltInTools = {},
  ...promptConfigWithoutLegacyTools
} = promptConfig;
const currentTtsConfig = conversationConfig.tts || {};
const currentConversationConfig = conversationConfig.conversation || {};
const currentToolIds = promptConfig.tool_ids || [];
const obsoleteToolIds = new Set(obsoleteTools.map((tool) => tool.id));
const toolIds = unique([
  ...currentToolIds.filter((toolId) => !obsoleteToolIds.has(toolId)),
  ...tools.map((tool) => tool.id),
]);
const nextPrompt = promptWithGithubFileTools(promptConfig.prompt || "");

conversationConfig.tts = {
  ...currentTtsConfig,
  voice_id: currentTtsConfig.voice_id || process.env.ELEVENLABS_AGENT_VOICE_ID,
  supported_voices: [],
  stability: Number(process.env.ELEVENLABS_AGENT_VOICE_STABILITY || 0.75),
  similarity_boost: Number(process.env.ELEVENLABS_AGENT_VOICE_SIMILARITY_BOOST || 0.9),
  speed: Number(process.env.ELEVENLABS_AGENT_VOICE_SPEED || currentTtsConfig.speed || 1),
};

conversationConfig.conversation = {
  ...currentConversationConfig,
  max_duration_seconds: maxConversationDurationSeconds,
};

conversationConfig.agent = {
  ...(conversationConfig.agent || {}),
  prompt: {
    ...promptConfigWithoutLegacyTools,
    prompt: nextPrompt,
    tool_ids: toolIds,
    built_in_tools: {
      ...(isPlainObject(currentBuiltInTools) ? currentBuiltInTools : {}),
      end_call: endCallBuiltInToolConfig(),
    },
  },
};

const updatedAgent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`, {
  method: "PATCH",
  body: JSON.stringify({
    conversation_config: conversationConfig,
    version_description:
      "Refresh phone-claw tools and stabilize the configured voice",
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
      detached_tool_ids: obsoleteTools.map((tool) => ({
        id: tool.id,
        name: tool.tool_config?.name,
      })),
      max_conversation_duration_seconds: maxConversationDurationSeconds,
      system_tools: ["end_call"],
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

async function verifyWorkerToolToken() {
  if (process.env.SKIP_TOOL_TOKEN_PREFLIGHT === "true") return;

  const response = await fetch(`${workerBaseUrl}/web-search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${toolToken}`,
    },
    body: JSON.stringify({
      query: "phone-claw webhook token preflight",
      max_results: 1,
    }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Webhook token preflight failed (${response.status}) against ${workerBaseUrl}. ` +
        "Refusing to patch ElevenLabs tool Authorization headers with a token the Worker rejects."
    );
  }
}

function webSearchToolConfig() {
  return webhookTool({
    name: "web_search",
    description:
      "Search the web for current events, recent facts, schedules, sports, products, documentation, companies, or anything that may have changed.",
    url: `${workerBaseUrl}/web-search`,
    required: ["query"],
    responseTimeoutSecs: 20,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      query: stringProperty({
        description: "Focused web search query. Keep it concise.",
      }),
      max_results: integerProperty({
        description: "Maximum results to return. Use 5 by default; use up to 8 only for deeper comparisons.",
      }),
    },
    responseDescription: "Web search response.",
    responseProperties: {
      ok: booleanProperty("Whether the search request succeeded."),
      query: stringProperty({ description: "Original query." }),
      provider: stringProperty({ description: "Search provider used." }),
      answer_text: stringProperty({
        description: "Compact spoken summary. Prefer this when answering by voice.",
      }),
      market_data: objectProperty({
        description: "Structured market quote when available.",
        properties: {
          provider: stringProperty({ description: "Market data source." }),
          instrument: stringProperty({ description: "Instrument name." }),
          benchmark: stringProperty({ description: "Benchmark name." }),
          symbol: stringProperty({ description: "Market symbol." }),
          price: numberProperty({ description: "Latest parsed price." }),
          currency: stringProperty({ description: "Quote currency." }),
          unit: stringProperty({ description: "Quote unit." }),
          change_text: stringProperty({ description: "Source-provided recent change text." }),
          url: stringProperty({ description: "Source URL." }),
          as_of: stringProperty({ description: "Timestamp when the quote was fetched." }),
        },
      }),
      market_history: objectProperty({
        description:
          "Structured recent market history when available, especially for WTI crude high/low/range questions.",
        properties: {
          provider: stringProperty({ description: "Market history source." }),
          instrument: stringProperty({ description: "Instrument name." }),
          benchmark: stringProperty({ description: "Benchmark name." }),
          symbol: stringProperty({ description: "Market symbol." }),
          range: stringProperty({ description: "History range, for example 1mo." }),
          interval: stringProperty({ description: "History interval." }),
          currency: stringProperty({ description: "Quote currency." }),
          unit: stringProperty({ description: "Quote unit." }),
          points: integerProperty({ description: "Number of daily points parsed." }),
          period_start: stringProperty({ description: "First date in the returned history." }),
          period_end: stringProperty({ description: "Last date in the returned history." }),
          highest_price: objectProperty({
            description: "Highest daily high in the returned history.",
            properties: {
              date: stringProperty({ description: "High date." }),
              price: numberProperty({ description: "High price." }),
            },
          }),
          lowest_price: objectProperty({
            description: "Lowest daily low in the returned history.",
            properties: {
              date: stringProperty({ description: "Low date." }),
              price: numberProperty({ description: "Low price." }),
            },
          }),
          latest_close: numberProperty({ description: "Latest daily close." }),
          latest_close_date: stringProperty({ description: "Latest daily close date." }),
          url: stringProperty({ description: "Source URL." }),
          as_of: stringProperty({ description: "Timestamp when the history was fetched." }),
        },
      }),
      results: arrayProperty({
        description: "Search results.",
        itemDescription: "One web search result.",
        properties: {
          title: stringProperty({ description: "Result title." }),
          url: stringProperty({ description: "Result URL." }),
          snippet: stringProperty({ description: "Short snippet or content summary." }),
          source: stringProperty({ description: "Source provider or domain." }),
        },
      }),
    },
  });
}

function githubSummaryToolConfig() {
  return webhookTool({
    name: "github_summary",
    description:
      "Returns read-only summaries of open GitHub issues or pull requests visible to the GitHub CLI account authenticated on the private phone-claw bridge. Supports optional repo, owner, and organization filters.",
    url: `${workerBaseUrl}/github-summary`,
    required: ["item_type"],
    forcePreToolSpeech: true,
    toolCallSound: "typing",
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
          spoken_summary: stringProperty({
            description:
              "Two to four word voice-friendly description. Use this instead of reading the number by default.",
          }),
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
    forcePreToolSpeech: true,
    toolCallSound: "typing",
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
    forcePreToolSpeech: true,
    toolCallSound: "typing",
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
    forcePreToolSpeech: true,
    toolCallSound: "typing",
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
    forcePreToolSpeech: true,
    toolCallSound: "typing",
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

function himalayaEmailListToolConfig() {
  return webhookTool({
    name: "himalaya_email_list",
    description:
      "Read-only Himalaya CLI email envelope listing and search. Use paginated mode for recent or matching emails; use all_pages=true for complete folder lists or email-count questions.",
    url: `${workerBaseUrl}/cli/himalaya/email-list`,
    required: [],
    responseTimeoutSecs: 30,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      query: stringProperty({
        description:
          "Optional Himalaya envelope query, for example 'from example.com', 'subject invoice', or 'order by date desc'.",
      }),
      folder: stringProperty({
        description: "Mailbox folder name. Use INBOX by default.",
      }),
      page_size: integerProperty({
        description:
          "Maximum emails per page. Use 5 for short paginated phone answers; use 50 with all_pages=true.",
      }),
      page: integerProperty({
        description: "Page number starting at 1. Omit unless Andrew asks for more.",
      }),
      all_pages: booleanProperty(
        "Set true when Andrew asks for all emails in a folder, a complete list, or the total number of emails."
      ),
      max_pages: integerProperty({
        description:
          "Maximum pages to scan when all_pages=true. Use the default unless Andrew asks for an exhaustive large-folder scan.",
      }),
      max_items: integerProperty({
        description:
          "Maximum email envelopes to return when all_pages=true. Defaults to 200 to protect context; raise only when Andrew explicitly asks.",
      }),
    },
    responseDescription: "Himalaya email envelope list response.",
    responseProperties: {
      ...cliResponseProperties(),
      all_pages: booleanProperty("Whether the request scanned pages until completion or cap."),
      page: integerProperty({ description: "Returned page number." }),
      page_size: integerProperty({ description: "Requested page size." }),
      returned_count: integerProperty({ description: "Number of email envelopes returned." }),
      total_count: integerProperty({
        description:
          "Exact total only when complete/exact is true. Null when a paginated or capped response is partial.",
      }),
      pages_scanned: integerProperty({
        description: "Number of Himalaya envelope-list pages scanned.",
      }),
      max_items: integerProperty({
        description: "Maximum email envelopes allowed in this response.",
      }),
      has_more: booleanProperty(
        "True when more matching emails exist beyond the returned capped list. Null when unknown."
      ),
      complete: booleanProperty("Whether the result includes the complete matching list."),
      exact: booleanProperty("Whether total_count is exact."),
      capped: booleanProperty("Whether all_pages scanning stopped at max_items or max_pages."),
      items: arrayProperty({
        description: "Email envelopes returned by Himalaya.",
        itemDescription: "One email envelope.",
        properties: {
          id: stringProperty({ description: "Himalaya envelope id for reading." }),
          subject: stringProperty({ description: "Email subject." }),
          from: stringProperty({ description: "Email sender." }),
          to: stringProperty({ description: "Email recipients." }),
          date: stringProperty({ description: "Email date." }),
          has_attachment: booleanProperty("Whether the email has an attachment."),
        },
      }),
    },
  });
}

function himalayaEmailReadToolConfig() {
  return webhookTool({
    name: "himalaya_email_read",
    description:
      "Read-only Himalaya CLI email reader. Use this after himalaya_email_list gives an exact envelope id. It previews by default so it does not mark mail as read.",
    url: `${workerBaseUrl}/cli/himalaya/email-read`,
    required: ["id"],
    responseTimeoutSecs: 30,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      id: stringProperty({
        description: "Himalaya envelope id returned by himalaya_email_list.",
      }),
      folder: stringProperty({
        description: "Mailbox folder name. Use the same folder used for the list call.",
      }),
      include_headers: booleanProperty(
        "Set true to include message headers. Keep true unless Andrew asks for body only."
      ),
      max_raw_bytes: integerProperty({
        description:
          "Maximum raw output bytes. Use 200000 unless Andrew asks for a very long message.",
      }),
    },
    responseDescription: "Himalaya email message response.",
    responseProperties: cliResponseProperties(),
  });
}

function himalayaEmailArchiveToolConfig() {
  return webhookTool({
    name: "himalaya_email_archive",
    description:
      "Archives one or more emails by moving Himalaya envelopes from the source folder to the archive folder. This is a write action and requires Andrew's explicit confirmation.",
    url: `${workerBaseUrl}/cli/himalaya/email-archive`,
    required: ["confirmed"],
    responseTimeoutSecs: 30,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      id: stringProperty({
        description:
          "Single Himalaya envelope id returned by himalaya_email_list. Use ids instead when archiving multiple emails.",
      }),
      ids: stringArrayProperty(
        "Multiple Himalaya envelope ids returned by himalaya_email_list. Use this when Andrew confirms archiving more than one email."
      ),
      envelope_ids: stringArrayProperty(
        "Alias for ids. Multiple Himalaya envelope ids returned by himalaya_email_list."
      ),
      folder: stringProperty({
        description: "Source mailbox folder. Use INBOX by default.",
      }),
      archive_folder: stringProperty({
        description:
          "Target archive folder. Use [Gmail]/All Mail by default unless Andrew specifies another folder.",
      }),
      confirmed: booleanProperty(
        "Must be true only after Andrew verbally confirms the exact email archive action."
      ),
    },
    responseDescription: "Himalaya email archive response.",
    responseProperties: emailWriteResponseProperties(),
  });
}

function himalayaDraftCreateToolConfig() {
  return webhookTool({
    name: "himalaya_draft_create",
    description:
      "Creates a saved Gmail/Himalaya draft for a new email. This does not send email and requires Andrew's explicit confirmation.",
    url: `${workerBaseUrl}/cli/himalaya/draft-create`,
    required: ["to", "subject", "confirmed"],
    responseTimeoutSecs: 35,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      to: stringProperty({
        description: "Recipient email address or comma-separated recipients.",
      }),
      cc: stringProperty({ description: "Optional CC recipients." }),
      bcc: stringProperty({ description: "Optional BCC recipients." }),
      subject: stringProperty({
        description: "Draft subject. Confirm this exact subject before use.",
      }),
      body: stringProperty({
        description: "Draft body. Confirm the key content before use.",
      }),
      draft_folder: stringProperty({
        description: "Draft folder. Use [Gmail]/Drafts by default.",
      }),
      confirmed: booleanProperty(
        "Must be true only after Andrew verbally confirms the exact draft creation."
      ),
    },
    responseDescription: "Himalaya draft creation response.",
    responseProperties: emailWriteResponseProperties(),
  });
}

function himalayaDraftReplyToolConfig() {
  return webhookTool({
    name: "himalaya_draft_reply",
    description:
      "Creates a saved Gmail/Himalaya reply draft for an existing email envelope. This does not send email and requires Andrew's explicit confirmation.",
    url: `${workerBaseUrl}/cli/himalaya/draft-reply`,
    required: ["id", "confirmed"],
    responseTimeoutSecs: 35,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      id: stringProperty({
        description: "Himalaya envelope id returned by himalaya_email_list.",
      }),
      folder: stringProperty({
        description: "Source mailbox folder. Use INBOX by default.",
      }),
      body: stringProperty({
        description: "Reply draft body. Confirm the key content before use.",
      }),
      reply_all: booleanProperty("Set true only when Andrew asks to reply all."),
      draft_folder: stringProperty({
        description: "Draft folder. Use [Gmail]/Drafts by default.",
      }),
      confirmed: booleanProperty(
        "Must be true only after Andrew verbally confirms the exact reply draft creation."
      ),
    },
    responseDescription: "Himalaya reply draft creation response.",
    responseProperties: emailWriteResponseProperties(),
  });
}

function himalayaEmailForwardToolConfig() {
  return webhookTool({
    name: "himalaya_email_forward",
    description:
      "Creates a saved Gmail/Himalaya forward draft for an existing email envelope. It includes Andrew's optional message above the forwarded content and preserves the original email HTML inline when available. It does not attach the original .eml, does not send email, and requires Andrew's explicit confirmation.",
    url: `${workerBaseUrl}/cli/himalaya/email-forward`,
    required: ["id", "to", "confirmed"],
    responseTimeoutSecs: 45,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      id: stringProperty({
        description: "Himalaya envelope id returned by himalaya_email_list.",
      }),
      folder: stringProperty({
        description: "Source mailbox folder. Use INBOX by default.",
      }),
      to: stringProperty({
        description:
          "Forwarding recipient email address or comma-separated recipients. Must include explicit email addresses.",
      }),
      cc: stringProperty({ description: "Optional CC recipients." }),
      bcc: stringProperty({ description: "Optional BCC recipients." }),
      subject: stringProperty({
        description:
          "Optional forward draft subject. Omit to use Fwd: plus the original subject.",
      }),
      body: stringProperty({
        description: "Optional message to include above the forwarded email.",
      }),
      draft_folder: stringProperty({
        description: "Draft folder. Use [Gmail]/Drafts by default.",
      }),
      confirmed: booleanProperty(
        "Must be true only after Andrew verbally confirms the exact forward draft recipient and message."
      ),
    },
    responseDescription: "Himalaya email forward draft response.",
    responseProperties: emailWriteResponseProperties(),
  });
}

function createReplyAllDraftToolConfig() {
  return webhookTool({
    name: "create_reply_all_draft",
    description:
      "Creates a saved Gmail/Himalaya reply-all draft for an existing email envelope. It includes Andrew's new message above the quoted original thread, preserves the original HTML inline when available, does not send email, and requires Andrew's explicit confirmation.",
    url: `${workerBaseUrl}/cli/himalaya/create-reply-all-draft`,
    required: ["id", "confirmed"],
    responseTimeoutSecs: 45,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      id: stringProperty({
        description: "Himalaya envelope id returned by himalaya_email_list.",
      }),
      folder: stringProperty({
        description: "Source mailbox folder. Use INBOX by default.",
      }),
      body: stringProperty({
        description:
          "Andrew's new reply-all draft message. Keep paragraph breaks/newlines so the saved draft reads naturally above the quoted original thread.",
      }),
      draft_folder: stringProperty({
        description: "Draft folder. Use [Gmail]/Drafts by default.",
      }),
      confirmed: booleanProperty(
        "Must be true only after Andrew verbally confirms the exact reply-all draft creation."
      ),
    },
    responseDescription: "Gmail/Himalaya reply-all draft response.",
    responseProperties: emailWriteResponseProperties(),
  });
}

function createForwardDraftToolConfig() {
  return webhookTool({
    name: "create_forward_draft",
    description:
      "Creates a saved Gmail/Himalaya forward draft for an existing email envelope. It includes Andrew's optional message above the forwarded content, preserves the original email HTML inline when available, does not attach the original .eml, does not send email, and requires Andrew's explicit confirmation.",
    url: `${workerBaseUrl}/cli/himalaya/create-forward-draft`,
    required: ["id", "to", "confirmed"],
    responseTimeoutSecs: 45,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      id: stringProperty({
        description: "Himalaya envelope id returned by himalaya_email_list.",
      }),
      folder: stringProperty({
        description: "Source mailbox folder. Use INBOX by default.",
      }),
      to: stringProperty({
        description:
          "Forwarding recipient email address or comma-separated recipients. Must include explicit email addresses.",
      }),
      cc: stringProperty({ description: "Optional CC recipients." }),
      bcc: stringProperty({ description: "Optional BCC recipients." }),
      subject: stringProperty({
        description:
          "Optional forward draft subject. Omit to use Fwd: plus the original subject.",
      }),
      body: stringProperty({
        description:
          "Optional message to include above the forwarded email. Keep paragraph breaks/newlines so the saved draft reads naturally.",
      }),
      draft_folder: stringProperty({
        description: "Draft folder. Use [Gmail]/Drafts by default.",
      }),
      confirmed: booleanProperty(
        "Must be true only after Andrew verbally confirms the exact forward draft recipient and message."
      ),
    },
    responseDescription: "Gmail/Himalaya forward draft response.",
    responseProperties: emailWriteResponseProperties(),
  });
}

function himalayaEmailSendToolConfig() {
  return webhookTool({
    name: "himalaya_email_send",
    description:
      "Emergency-only Gmail/Himalaya email sender. Use only when Andrew explicitly asks to send an emergency email. Before this tool can send, the exact recipients, subject, and body must be previewed verbally, and Andrew must give an extra explicit confirmation.",
    url: `${workerBaseUrl}/cli/himalaya/email-send`,
    required: ["to", "subject", "body", "emergency", "previewed", "confirmed"],
    responseTimeoutSecs: 45,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      to: stringProperty({
        description:
          "Recipient email address or comma-separated recipients. Must include explicit email addresses.",
      }),
      cc: stringProperty({ description: "Optional CC recipients." }),
      bcc: stringProperty({ description: "Optional BCC recipients." }),
      subject: stringProperty({
        description: "Email subject. Must be previewed exactly before sending.",
      }),
      body: stringProperty({
        description: "Email body. Must be previewed exactly before sending.",
      }),
      emergency: booleanProperty(
        "Must be true only when Andrew explicitly says this is an emergency send. Otherwise use draft tools."
      ),
      previewed: booleanProperty(
        "Must be true only after the agent has verbally previewed the exact recipients, subject, and body to Andrew."
      ),
      confirmed: booleanProperty(
        "Must be true only after Andrew gives a second explicit confirmation to send now after hearing the preview."
      ),
    },
    responseDescription: "Himalaya emergency email send response.",
    responseProperties: emailWriteResponseProperties(),
  });
}

function otterSpeechesListToolConfig() {
  return webhookTool({
    name: "otter_speeches_list",
    description:
      "Read-only Otter AI CLI transcript listing. Use this to find recent owned/shared/all Otter transcripts. The otid field is the id to pass to Otter get/search.",
    url: `${workerBaseUrl}/cli/otter/speeches-list`,
    required: [],
    responseTimeoutSecs: 30,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      source: stringProperty({
        description: "Transcript source filter. Use owned by default.",
        values: ["owned", "shared", "all"],
      }),
      days: integerProperty({
        description: "Optional lookback window in days.",
      }),
      page_size: integerProperty({
        description: "Maximum transcripts to return. Use 5 by default for phone answers.",
      }),
    },
    responseDescription: "Otter transcript list response.",
    responseProperties: {
      ...cliResponseProperties(),
      returned_count: integerProperty({ description: "Number of transcripts returned." }),
      items: arrayProperty({
        description: "Otter transcripts.",
        itemDescription: "One Otter transcript.",
        properties: otterSpeechProperties(),
      }),
    },
  });
}

function otterSpeechGetToolConfig() {
  return webhookTool({
    name: "otter_speech_get",
    description:
      "Read-only Otter AI CLI transcript fetcher. Gets raw transcript JSON from Otter. Use the otid returned by otter_speeches_list as speech_id.",
    url: `${workerBaseUrl}/cli/otter/speech-get`,
    required: ["speech_id"],
    responseTimeoutSecs: 45,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      speech_id: stringProperty({
        description:
          "Otter otid returned by otter_speeches_list. Do not use speech_id if an otid is available.",
      }),
      max_raw_bytes: integerProperty({
        description:
          "Maximum raw JSON bytes to return. Use 500000 for raw transcript JSON unless Andrew asks for less.",
      }),
    },
    responseDescription: "Otter raw transcript JSON response.",
    responseProperties: {
      ...cliResponseProperties(),
      speech_id: stringProperty({ description: "Requested Otter otid." }),
      speech: objectProperty({
        description: "Compact Otter transcript metadata.",
        properties: otterSpeechProperties(),
      }),
    },
  });
}

function otterSpeechSearchToolConfig() {
  return webhookTool({
    name: "otter_speech_search",
    description:
      "Read-only Otter AI CLI transcript search. Use it to search within one Otter transcript by text query, speaker name, or both after otter_speeches_list identifies the otid.",
    url: `${workerBaseUrl}/cli/otter/speech-search`,
    required: ["speech_id"],
    responseTimeoutSecs: 30,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      speech_id: stringProperty({
        description: "Otter otid returned by otter_speeches_list.",
      }),
      query: stringProperty({
        description:
          "Optional search terms to find within the Otter transcript. Provide query, speaker, or both.",
      }),
      speaker: stringProperty({
        description:
          "Optional speaker name filter. Use when Andrew asks what a specific person said or asks to search by speaker.",
      }),
      size: integerProperty({
        description: "Maximum search hits. Use 20 by default.",
      }),
    },
    responseDescription: "Otter transcript search response.",
    responseProperties: {
      ...cliResponseProperties(),
      speech_id: stringProperty({ description: "Requested Otter otid." }),
      query: stringProperty({ description: "Search query used, if any." }),
      speaker: stringProperty({ description: "Speaker filter used, if any." }),
      returned_count: integerProperty({ description: "Number of matching transcript segments." }),
      items: arrayProperty({
        description: "Speaker-aware transcript segment matches when speaker filtering is used.",
        itemDescription: "One matching Otter transcript segment.",
        properties: {
          speaker: stringProperty({ description: "Speaker label or name when available." }),
          text: stringProperty({ description: "Transcript segment text." }),
          start_time: stringProperty({ description: "Segment start time when available." }),
          end_time: stringProperty({ description: "Segment end time when available." }),
          path: stringProperty({ description: "JSON path for debugging." }),
        },
      }),
    },
  });
}

function githubCliCommonToolConfig() {
  return webhookTool({
    name: "github_cli_common",
    description:
      "Read-only wrapper around common GitHub CLI commands for repo, issue, PR, and GitHub search lookups. Use existing github_cli_ls and github_cli_cat for repository files.",
    url: `${workerBaseUrl}/cli/github/common`,
    required: ["action"],
    responseTimeoutSecs: 30,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      action: stringProperty({
        description:
          "The GitHub CLI action to run: repo_view, issue_list, issue_view, pr_list, pr_view, search_issues, or search_prs.",
        values: [
          "repo_view",
          "issue_list",
          "issue_view",
          "pr_list",
          "pr_view",
          "search_issues",
          "search_prs",
        ],
      }),
      repo: stringProperty({
        description:
          "Full repository name in owner/name format. Required for repo_view, issue_list, issue_view, pr_list, and pr_view.",
      }),
      number: integerProperty({
        description: "Issue or pull request number for issue_view or pr_view.",
      }),
      state: stringProperty({
        description: "Issue or pull request state for list actions.",
        values: ["open", "closed", "all"],
      }),
      query: stringProperty({
        description: "GitHub search query for search_issues or search_prs.",
      }),
      limit: integerProperty({
        description: "Maximum results for list/search actions. Use 5 by default.",
      }),
    },
    responseDescription: "GitHub CLI response.",
    responseProperties: {
      ...cliResponseProperties(),
      action: stringProperty({ description: "Action performed." }),
      gh_equivalent: stringProperty({ description: "Closest shell command equivalent." }),
    },
  });
}

function rssListFeedsToolConfig() {
  return webhookTool({
    name: "rss_list_feeds",
    description:
      "List configured RSS feeds available to the private bridge. Use this when Andrew asks what feeds are configured or when you need the feed_id for a named private or public RSS feed.",
    url: `${workerBaseUrl}/cli/rss/feeds`,
    required: [],
    responseTimeoutSecs: 15,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {},
    responseDescription: "Configured RSS feeds.",
    responseProperties: {
      ok: booleanProperty("Whether configured feed listing succeeded."),
      status: stringProperty({ description: "Status code." }),
      provider: stringProperty({ description: "RSS backend provider." }),
      returned_count: integerProperty({ description: "Number of configured feeds." }),
      answer_text: stringProperty({
        description: "Compact spoken summary. Prefer this for voice responses.",
      }),
      feeds: arrayProperty({
        description: "Configured RSS feeds.",
        itemDescription: "One configured RSS feed.",
        properties: rssFeedProperties(),
      }),
    },
  });
}

function rssRecentEntriesToolConfig() {
  return webhookTool({
    name: "rss_recent_entries",
    description:
      "List recent entries from configured public or private RSS feeds. Optionally pass feed_id when Andrew asks for one named feed.",
    url: `${workerBaseUrl}/cli/rss/recent`,
    required: [],
    responseTimeoutSecs: 20,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      feed_id: stringProperty({
        description:
          "Optional configured feed id, for example the id returned by rss_list_feeds. Omit to search all configured feeds.",
      }),
      limit: integerProperty({
        description:
          "Maximum articles to return. Omit for the default 200-entry recent list; use up to 1000 only when Andrew explicitly asks for a large list or broad export.",
      }),
      refresh: booleanProperty(
        "Set true only when Andrew explicitly asks to refresh the bridge cache now."
      ),
    },
    responseDescription: "Recent configured RSS entries.",
    responseProperties: rssEntriesResponseProperties(),
  });
}

function rssSearchEntriesToolConfig() {
  return webhookTool({
    name: "rss_search_entries",
    description:
      "Search configured public or private RSS feeds by keyword and optional published date range. Optionally pass feed_id for one named feed.",
    url: `${workerBaseUrl}/cli/rss/search`,
    required: ["query"],
    responseTimeoutSecs: 20,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      query: stringProperty({
        description: "Search query or keywords, for example AI, oil, China, tariffs.",
      }),
      feed_id: stringProperty({
        description:
          "Optional configured feed id, for example the id returned by rss_list_feeds. Omit to search all configured feeds.",
      }),
      start_date: stringProperty({
        description: "Optional inclusive published-after date or timestamp.",
      }),
      end_date: stringProperty({
        description: "Optional inclusive published-before date or timestamp.",
      }),
      limit: integerProperty({
        description:
          "Maximum articles to return. Omit for the default 200-entry search result list; use up to 1000 only when Andrew explicitly asks for a large search or broad export.",
      }),
      refresh: booleanProperty(
        "Set true only when Andrew explicitly asks to refresh the bridge cache now."
      ),
    },
    responseDescription: "Configured RSS search results.",
    responseProperties: rssEntriesResponseProperties(),
  });
}

function rssGetArticleTextToolConfig() {
  return webhookTool({
    name: "rss_get_article_text",
    description:
      "Fetch readable article text for a configured RSS entry id returned by rss_recent_entries or rss_search_entries. Use article_url only when an entry id is not available.",
    url: `${workerBaseUrl}/cli/rss/article-text`,
    required: ["entry_id"],
    responseTimeoutSecs: 30,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      entry_id: stringProperty({
        description: "Entry id from rss_recent_entries or rss_search_entries.",
      }),
      article_url: stringProperty({
        description: "Optional article URL when an entry id is not available.",
      }),
      feed_id: stringProperty({
        description:
          "Optional configured feed id. Include it when known to avoid searching all feeds.",
      }),
      max_text_chars: integerProperty({
        description:
          "Maximum article text characters to return. Use 30000 by default; lower for short phone summaries.",
      }),
      refresh: booleanProperty(
        "Set true only when Andrew explicitly asks to refresh the bridge cache now."
      ),
    },
    responseDescription: "Configured RSS article text.",
    responseProperties: {
      ok: booleanProperty("Whether article text retrieval succeeded."),
      status: stringProperty({ description: "Status code." }),
      answer_text: stringProperty({
        description:
          "Compact spoken summary of article retrieval. Prefer this before diagnostic fields.",
      }),
      full_article_available: booleanProperty(
        "True when the feed entry should be treated as full article text."
      ),
      provider: stringProperty({ description: "RSS backend provider." }),
      source: stringProperty({ description: "Configured feed id." }),
      entry_id: stringProperty({ description: "Configured RSS entry id." }),
      feed_id: stringProperty({ description: "Configured feed id." }),
      feed_title: stringProperty({ description: "Configured feed title." }),
      content_source: stringProperty({
        description: "Source of the returned text, such as feed_content_encoded or feed_summary.",
      }),
      full_text_chars: integerProperty({ description: "Full extracted text length." }),
      returned_text_chars: integerProperty({ description: "Returned text length." }),
      full_text_truncated: booleanProperty("Whether full_text was truncated."),
      full_text: stringProperty({
        description:
          "Readable article text. Summarize by voice; do not read the entire article unless Andrew asks.",
      }),
      access_note: stringProperty({
        description: "Note when the returned text appears to be an excerpt.",
      }),
      entry: objectProperty({
        description: "Article metadata.",
        properties: rssEntryProperties(),
      }),
    },
  });
}

function rssRefreshFeedsToolConfig() {
  return webhookTool({
    name: "rss_refresh_feeds",
    description:
      "Refresh the bridge cache for configured RSS feeds. Do not call this before every RSS lookup; use it only when Andrew asks to refresh now.",
    url: `${workerBaseUrl}/cli/rss/refresh`,
    required: [],
    responseTimeoutSecs: 20,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      feed_id: stringProperty({
        description:
          "Optional configured feed id. Omit to refresh all configured feeds.",
      }),
    },
    responseDescription: "Configured RSS refresh response.",
    responseProperties: {
      ok: booleanProperty("Whether one or more feeds refreshed."),
      status: stringProperty({ description: "Status code." }),
      provider: stringProperty({ description: "RSS backend provider." }),
      refreshed_count: integerProperty({ description: "Number of feeds refreshed." }),
      returned_count: integerProperty({ description: "Number of feeds refreshed." }),
      feeds: arrayProperty({
        description: "Refresh status by configured feed.",
        itemDescription: "One feed refresh status.",
        properties: rssFeedProperties(),
      }),
      answer_text: stringProperty({
        description: "Compact spoken summary. Prefer this for voice responses.",
      }),
    },
  });
}

function conversationHistorySearchToolConfig() {
  return webhookTool({
    name: "conversation_history_search",
    description:
      "Search archived phone-claw phone conversations by keyword and optional date range. Returns compact hundred-word summaries and keywords, not full transcripts.",
    url: `${workerBaseUrl}/conversation-history/search`,
    required: [],
    responseTimeoutSecs: 20,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      query: stringProperty({
        description:
          "Optional keyword or phrase to search across summaries, keywords, and transcripts.",
      }),
      start_date: stringProperty({
        description: "Optional inclusive start date or timestamp.",
      }),
      end_date: stringProperty({
        description: "Optional inclusive end date or timestamp.",
      }),
      limit: integerProperty({
        description: "Maximum archived conversations to return. Use 5 by default.",
      }),
    },
    responseDescription: "Archived conversation search response.",
    responseProperties: {
      ok: booleanProperty("Whether the search succeeded."),
      status: stringProperty({ description: "Status code." }),
      query: stringProperty({ description: "Search query used." }),
      start_date: stringProperty({ description: "Start date used." }),
      end_date: stringProperty({ description: "End date used." }),
      returned_count: integerProperty({ description: "Number of conversations returned." }),
      answer_text: stringProperty({
        description: "Compact spoken summary. Prefer this before reading raw fields.",
      }),
      items: arrayProperty({
        description: "Archived conversation matches.",
        itemDescription: "One archived conversation summary.",
        properties: conversationSummaryProperties(),
      }),
    },
  });
}

function conversationHistoryGetToolConfig() {
  return webhookTool({
    name: "conversation_history_get",
    description:
      "Fetch compact details for a specific archived phone-claw conversation_id returned by conversation_history_search. Returns a capped transcript excerpt by default to avoid overloading the live call.",
    url: `${workerBaseUrl}/conversation-history/get`,
    required: ["conversation_id"],
    responseTimeoutSecs: 20,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      conversation_id: stringProperty({
        description: "Conversation id returned by conversation_history_search.",
      }),
      include_transcript: booleanProperty(
        "Set true only when Andrew explicitly asks for transcript details. The response still returns a capped excerpt."
      ),
      include_tool_details: booleanProperty(
        "Set true only when Andrew explicitly asks for tool result details. The response still returns capped previews."
      ),
      max_transcript_turns: integerProperty({
        description: "Maximum latest transcript turns to return. Use 12 by default; maximum is 50.",
      }),
      max_tool_items: integerProperty({
        description: "Maximum tool calls/results to return. Use 12 by default; maximum is 50.",
      }),
    },
    responseDescription: "Archived conversation compact retrieval response.",
    responseProperties: {
      ok: booleanProperty("Whether the retrieval succeeded."),
      status: stringProperty({ description: "Status code." }),
      answer_text: stringProperty({
        description: "Compact spoken summary. Prefer this before using transcript excerpts.",
      }),
      conversation: objectProperty({
        description: "Compact archived conversation record.",
        properties: {
          ...conversationSummaryProperties(),
          transcript_turn_count: integerProperty({ description: "Total transcript turns stored." }),
          transcript_excerpt: arrayProperty({
            description: "Latest capped transcript turns.",
            itemDescription: "One compact transcript turn.",
            properties: {
              excerpt_index: integerProperty({ description: "Index within the returned excerpt." }),
              role: stringProperty({ description: "Turn role." }),
              message: stringProperty({ description: "Truncated turn message." }),
            },
          }),
          transcript_truncated: booleanProperty("Whether earlier transcript turns were omitted."),
          tool_calls: arrayProperty({
            description: "Capped tool call list with parameter keys only.",
            itemDescription: "One tool call.",
            properties: {
              transcript_index: integerProperty({ description: "Original transcript turn index." }),
              tool_name: stringProperty({ description: "Tool name." }),
              param_keys: stringArrayProperty("Tool parameter keys present in the call."),
            },
          }),
          tool_call_truncated: booleanProperty("Whether additional tool calls were omitted."),
          tool_result_count: integerProperty({ description: "Total stored tool results." }),
          tool_results: arrayProperty({
            description: "Optional capped tool result previews.",
            itemDescription: "One tool result.",
            properties: {
              transcript_index: integerProperty({ description: "Original transcript turn index." }),
              tool_name: stringProperty({ description: "Tool name." }),
              is_error: booleanProperty("Whether the tool errored."),
              status: stringProperty({ description: "Tool result status." }),
              action: stringProperty({ description: "Tool result action when applicable." }),
              returned_count: integerProperty({ description: "Returned item count when applicable." }),
              answer_text: stringProperty({ description: "Truncated spoken result summary." }),
              result_preview: stringProperty({ description: "Short result preview." }),
            },
          }),
          tool_results_truncated: booleanProperty("Whether additional tool results were omitted."),
        },
      }),
    },
  });
}

function claudeCodeToolConfig() {
  return webhookTool({
    name: "claude_code",
    description:
      "Explicit escalation tool for Claude Code running on the private EC2 bridge. Use only when Andrew asks to use Claude Code, asks to start/check/steer a Claude Code session, or confirms that a complex code change/test run should be delegated.",
    url: `${workerBaseUrl}/cli/claude-code`,
    required: ["action"],
    responseTimeoutSecs: 20,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      action: stringProperty({
        description:
          "Action to run: auth_status checks Claude auth; start_session creates a session id; submit_task starts an async Claude Code job; job_status checks an existing job; steer_session appends new steering instructions to an existing session or job.",
        values: ["auth_status", "start_session", "submit_task", "job_status", "steer_session"],
      }),
      task: stringProperty({
        description:
          "Task for Claude Code. Required for submit_task. Include the exact repository/task Andrew confirmed.",
      }),
      repo_path: stringProperty({
        description:
          "Optional absolute repository path on the EC2 bridge. Omit for the default phone-claw repo.",
      }),
      session_id: stringProperty({
        description:
          "Optional Claude Code session UUID. Reuse this to continue the same Claude Code conversation.",
      }),
      job_id: stringProperty({
        description:
          "Claude Code job UUID to check with action=job_status or to steer with action=steer_session.",
      }),
      instructions: stringProperty({
        description:
          "New steering instructions for action=steer_session. Use this when Andrew wants to update, redirect, or add requirements to an already-started Claude Code session/job.",
      }),
      mode: stringProperty({
        description:
          "Use plan for read-only planning. Use run only after Andrew confirms edits/tests should run.",
        values: ["plan", "run"],
      }),
      confirmed: booleanProperty(
        "Must be true only after Andrew explicitly confirms the exact Claude Code task and repository."
      ),
      max_seconds: integerProperty({
        description:
          "Maximum job runtime in seconds. Defaults to 600. Use lower values for phone-call experiments.",
      }),
    },
    responseDescription: "Claude Code bridge response.",
    responseProperties: {
      ok: booleanProperty("Whether the bridge request succeeded."),
      status: stringProperty({
        description:
          "Status such as ok, session_ready, running, steering_recorded, completed, failed, claude_not_authenticated, confirmation_required, or job_not_found.",
      }),
      action: stringProperty({ description: "Action performed." }),
      authenticated: booleanProperty("Whether Claude Code is authenticated on the bridge."),
      auth_method: stringProperty({ description: "Claude Code auth method when known." }),
      session_id: stringProperty({ description: "Claude Code session UUID." }),
      job_id: stringProperty({ description: "Claude Code async job UUID." }),
      mode: stringProperty({ description: "Claude Code mode: plan or run." }),
      working_directory: stringProperty({ description: "Repository path used on the bridge." }),
      steering_file: stringProperty({
        description:
          "Bridge-local JSONL file where steering instructions for this session are stored.",
      }),
      steering_id: stringProperty({ description: "Steering instruction UUID." }),
      steering_instruction_count: integerProperty({
        description: "Number of steering instructions recorded for this session.",
      }),
      latest_steering_instruction: stringProperty({
        description: "Latest recorded steering instruction, truncated.",
      }),
      running_job: booleanProperty("Whether a matching Claude Code job is currently running."),
      instructions_preview: stringProperty({
        description: "Short preview of the steering instructions that were recorded.",
      }),
      created_at: stringProperty({ description: "Job creation timestamp." }),
      updated_at: stringProperty({ description: "Last job update timestamp." }),
      exit_code: integerProperty({ description: "Claude Code process exit code." }),
      signal: stringProperty({ description: "Signal if the process was terminated." }),
      output_preview: stringProperty({
        description: "Truncated Claude Code output for voice summarization.",
      }),
      error_text: stringProperty({ description: "Claude Code stderr or startup error." }),
      answer_text: stringProperty({
        description: "Compact spoken summary. Prefer this for voice responses.",
      }),
    },
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
  responseTimeoutSecs = 15,
  forcePreToolSpeech = false,
  toolCallSound = null,
}) {
  return {
    type: "webhook",
    name,
    description,
    response_timeout_secs: responseTimeoutSecs,
    disable_interruptions: false,
    force_pre_tool_speech: forcePreToolSpeech,
    pre_tool_speech: "auto",
    assignments: [],
    tool_call_sound: toolCallSound,
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

function endCallBuiltInToolConfig() {
  return {
    type: "system",
    name: "end_call",
    description:
      "End the call when Andrew clearly says goodbye, says that's all for now, thanks the assistant and says goodbye, or otherwise indicates the conversation is complete.",
    response_timeout_secs: 20,
    params: {
      system_tool_type: "end_call",
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

function rssEntriesResponseProperties() {
  return {
    ok: booleanProperty("Whether the RSS request succeeded."),
    status: stringProperty({ description: "Status code." }),
    provider: stringProperty({ description: "RSS backend provider." }),
    source: stringProperty({ description: "Feed source or configured feed id." }),
    query: stringProperty({ description: "Search query when applicable." }),
    start_date: stringProperty({ description: "Start date when applicable." }),
    end_date: stringProperty({ description: "End date when applicable." }),
    feed_id: stringProperty({ description: "Configured feed id when applicable." }),
    limit: integerProperty({ description: "Effective result limit applied by PhoneClaw." }),
    max_limit: integerProperty({ description: "Maximum result limit supported by PhoneClaw." }),
    returned_count: integerProperty({ description: "Number of entries returned." }),
    total_count: integerProperty({ description: "Total matching entries found before limiting." }),
    available_count: integerProperty({
      description: "Matching entries available from the configured upstream feeds before limiting.",
    }),
    has_more: booleanProperty("Whether additional matching entries were omitted by the limit."),
    category_id: integerProperty({ description: "Legacy category id, when present." }),
    category_title: stringProperty({ description: "Legacy category title, when present." }),
    answer_text: stringProperty({
      description: "Compact spoken summary. Prefer this before reading item details.",
    }),
    feeds: arrayProperty({
      description: "Configured feeds consulted.",
      itemDescription: "One feed status.",
      properties: rssFeedProperties(),
    }),
    items: arrayProperty({
      description: "RSS entries.",
      itemDescription: "One RSS entry.",
      properties: rssEntryProperties(),
    }),
  };
}

function rssFeedProperties() {
  return {
    id: stringProperty({ description: "Configured feed id." }),
    title: stringProperty({ description: "Configured feed title." }),
    ok: booleanProperty("Whether the feed request succeeded when status is included."),
    status: stringProperty({ description: "Feed request status, when included." }),
    private: booleanProperty("Whether the feed URL is marked private."),
    cache_seconds: integerProperty({ description: "Bridge cache TTL in seconds." }),
    cache_status: stringProperty({ description: "Cache status, such as hit or refreshed." }),
    fetched_at: stringProperty({ description: "Last fetched timestamp, when available." }),
    item_count: integerProperty({ description: "Number of entries parsed from the feed." }),
    stale_reason: stringProperty({ description: "Reason stale cache was used, when applicable." }),
    feed_url: stringProperty({ description: "Feed URL with private tokens redacted." }),
  };
}

function rssEntryProperties() {
  return {
    id: stringProperty({ description: "RSS entry id." }),
    title: stringProperty({ description: "Article title." }),
    url: stringProperty({ description: "Article URL." }),
    author: stringProperty({ description: "Article author." }),
    published_at: stringProperty({ description: "Published timestamp." }),
    created_at: stringProperty({ description: "Created timestamp when reported." }),
    changed_at: stringProperty({ description: "Updated timestamp when reported." }),
    status: stringProperty({ description: "Read status." }),
    starred: booleanProperty("Whether the article is starred."),
    reading_time: integerProperty({ description: "Estimated reading time." }),
    feed_id: stringProperty({ description: "Configured feed id." }),
    feed_title: stringProperty({ description: "Feed title." }),
    feed_url: stringProperty({ description: "Feed URL." }),
    category_title: stringProperty({ description: "Category title." }),
    content_source: stringProperty({
      description: "Optional source hint such as feed_content_encoded.",
    }),
    full_text_available: booleanProperty("Whether full text is known to be available."),
    excerpt: stringProperty({ description: "Short readable excerpt." }),
  };
}

function emailWriteResponseProperties() {
  return {
    ...cliResponseProperties(),
    action: stringProperty({
      description:
        "Action performed, such as archived, draft_created, reply_draft_created, forward_draft_created, email_send_preview_required, email_send_confirmation_required, email_sent, email_send_timeout, or email_send_failed.",
    }),
    id: stringProperty({ description: "Himalaya envelope id when applicable." }),
    ids: stringArrayProperty("Himalaya envelope ids when a batch action was requested."),
    archived_count: integerProperty({ description: "Number of emails archived." }),
    failed_count: integerProperty({ description: "Number of email archive operations that failed." }),
    draft_id: stringProperty({ description: "Saved Himalaya draft envelope id when available." }),
    source_folder: stringProperty({ description: "Source folder when applicable." }),
    target_folder: stringProperty({ description: "Target folder when applicable." }),
    draft_folder: stringProperty({ description: "Draft folder when applicable." }),
    to: stringProperty({ description: "Email recipient when applicable." }),
    cc: stringProperty({ description: "Email CC recipients when applicable." }),
    bcc: stringProperty({ description: "Email BCC recipients when applicable." }),
    subject: stringProperty({ description: "Email subject when applicable." }),
    original_has_html: booleanProperty("Whether the forwarded original email had an HTML body."),
    original_has_plain: booleanProperty("Whether the original email had a plain-text body."),
    reply_all: booleanProperty("Whether the saved draft was a reply-all draft."),
    attached_original_eml: booleanProperty("Always false for reply/forward drafts; the original email is included inline, not attached as an .eml."),
    original_size_bytes: integerProperty({ description: "Original exported email size in bytes." }),
    emergency: booleanProperty("Whether the write was requested as an emergency send."),
    requires_preview: booleanProperty("Whether the tool requires a verbal preview first."),
    requires_confirmation: booleanProperty("Whether the tool requires another confirmation."),
    preview: objectProperty({
      description: "Exact email preview that must be read before sending.",
      properties: {
        to: stringProperty({ description: "Preview recipient." }),
        cc: stringProperty({ description: "Preview CC recipients." }),
        bcc: stringProperty({ description: "Preview BCC recipients." }),
        subject: stringProperty({ description: "Preview subject." }),
        body: stringProperty({ description: "Preview body." }),
      },
    }),
  };
}

function cliResponseProperties() {
  return {
    ok: booleanProperty("Whether the CLI command succeeded."),
    status: stringProperty({
      description: "Status code such as ok, cli_failed, cli_timeout, or cli_bridge_not_configured.",
    }),
    message: stringProperty({ description: "Error or status message." }),
    command: stringProperty({ description: "CLI command family that ran." }),
    answer_text: stringProperty({
      description: "Compact spoken summary. Prefer this before using raw JSON.",
    }),
    raw_json: stringProperty({
      description:
        "Raw CLI stdout, usually JSON. This may be truncated according to max_raw_bytes.",
    }),
    raw_truncated: booleanProperty("Whether raw_json was truncated."),
    stderr: stringProperty({ description: "CLI stderr, if any." }),
  };
}

function otterSpeechProperties() {
  return {
    otid: stringProperty({ description: "Otter otid. Use this for get/search." }),
    speech_id: stringProperty({ description: "Otter speech id when present." }),
    title: stringProperty({ description: "Transcript title." }),
    created_at: integerProperty({ description: "Creation timestamp when present." }),
    modified_time: integerProperty({ description: "Modified timestamp when present." }),
    start_time: integerProperty({ description: "Start timestamp when present." }),
    duration: integerProperty({ description: "Duration when present." }),
    owner_name: stringProperty({ description: "Owner name when present." }),
    summary_status: stringProperty({ description: "Otter summary status when present." }),
  };
}

function conversationSummaryProperties() {
  return {
    conversation_id: stringProperty({ description: "Archived conversation id." }),
    twilio_call_sid: stringProperty({ description: "Twilio Call SID when available." }),
    caller_number: stringProperty({ description: "Caller phone number when available." }),
    started_at: stringProperty({ description: "Conversation start timestamp." }),
    ended_at: stringProperty({ description: "Conversation end timestamp." }),
    duration_seconds: integerProperty({ description: "Conversation duration in seconds." }),
    status: stringProperty({ description: "Conversation status." }),
    summary: stringProperty({ description: "Hundred-word conversation summary." }),
    keywords: stringArrayProperty("Up to fifty extracted keywords."),
    tool_call_count: integerProperty({ description: "Number of tool calls in the conversation." }),
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

function numberProperty({ description }) {
  return {
    type: "number",
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
  const section = `Web search capability:
- You have a webhook tool named web_search.
- Use web_search when Andrew asks about current events, today, recent facts, schedules, sports, companies, products, documentation, or anything that may have changed.
- Do not use web_search for configured RSS article listing, configured RSS article search, or article discussion when the RSS tools can answer. Use the RSS tools first and answer from their returned article metadata or text.
- Use web_search after an RSS tool only when Andrew explicitly asks for outside web corroboration/comparison, or when the RSS tools return no relevant article or no usable text and you briefly say you are switching to broader web search.
- Use concise queries.
- Set max_results=5 by default. Use fewer only when Andrew explicitly asks for a very quick answer; use up to 8 for deeper comparisons.
- For sports schedules, include the sport/league/date if known.
- After using web_search, prefer the tool's answer_text field when it is present.
- If sports_events are returned, answer directly with the teams, times, statuses, scores, and venues that matter for Andrew's question.
- If market_data is returned, answer with that structured quote first and use web results only as backup context.
- If market_history is returned, answer high/low/range questions from that structured history first and include the dates for the high and low.
- If the returned results are incomplete or only show source snippets, say what the sources suggest and mention the uncertainty briefly.
- Do not say you cannot browse when the web_search tool is available.

Conversation memory:
- At the start of a call, the dynamic variable recent_conversation_context may contain compact summaries of recent archived phone-claw conversations. Use it quietly as background context; do not read it aloud unless Andrew asks what context you have.
- You have webhook tools named conversation_history_search and conversation_history_get.
- Use conversation_history_search when Andrew asks about prior phone calls, previous conversations, things discussed earlier, or wants to find a past call by keyword/date.
- conversation_history_search returns compact summaries and keywords only. Use conversation_history_get only when Andrew asks for transcript excerpts, tool calls, or exact details from a specific archived conversation_id. It returns capped excerpts by default; set include_transcript=true or include_tool_details=true only when Andrew explicitly asks for those details.
- If conversation history returns conversation_history_not_configured, say the memory tools are coded but the Neon/Postgres database URL still needs to be configured on the bridge.

GitHub capability:
- You have webhook tools named github_summary, github_cli_ls, github_cli_cat, github_issue_create, and github_issue_update.
- Use github_summary when Andrew asks how many open GitHub issues or pull requests he has, what they are about, what needs attention, or asks for quick GitHub triage.
- Use item_type="issues" for issue questions and item_type="pull_requests" for pull request questions.
- Use scope="involved" by default. Use scope="assigned", "authored", "mentioned", or "review_requested" only when Andrew asks for that narrower view.
- When summarizing GitHub issues or pull requests by voice, do not read issue or pull request numbers by default. Lead with each item's spoken_summary or a two-to-four-word description, then a short plain-English explanation. Read item numbers, URLs, and internal identifiers only if Andrew explicitly asks or is confirming a specific GitHub write action.
- When Andrew names a specific repository, pass repo in owner/name format, for example repo="octo-org/example-repo". When he names only an organization, pass organization, for example organization="octo-org".
- Use github_cli_ls to inspect a repository root, a folder, or a recursive folder tree. Use path="" or omit path for the root. Set recursive=true when Andrew asks for the full tree of a folder.
- Use github_cli_cat only when you know the exact file path. If the repo, path, or branch/ref is unclear, ask a short clarifying question.
- Use github_issue_create only after Andrew explicitly confirms the exact repo, title, and body. Set confirmed=true only after that confirmation.
- Use github_issue_update only after Andrew explicitly confirms the exact repo, issue number, and requested change. Set confirmed=true only after that confirmation.
- After creating or updating a GitHub issue, give a brief fifteen-second summary. Do not read the full title and body unless Andrew explicitly asks for the full details.
- The GitHub issue tools can create and update issues only. They cannot merge, approve, push code, or edit files.
- If a private repo returns 403, 404, or a GitHub validation failure, say the bridge's gh session may not have access to that repo, SSO authorization, org approval, or Contents read permission.

Claude Code capability:
- You have a webhook tool named claude_code that can check auth, start a session, submit an async Claude Code job on EC2, append steering instructions to an existing Claude Code session/job, and check job status.
- Do not use Claude Code by default. First solve directly with conversation, web_search, GitHub, email, or Otter tools when that is enough.
- Use claude_code only when Andrew explicitly asks to use Claude Code, asks to start/check a Claude Code session, or confirms that a complex code change or test run should be delegated to Claude Code.
- Use action="auth_status" when Andrew asks whether Claude Code is ready.
- Use action="start_session" when Andrew asks to start a Claude Code session. Remember and reuse the returned session_id.
- Before action="submit_task", repeat the exact repository/path and task, then ask Andrew to confirm. Set confirmed=true only after that confirmation.
- Use mode="plan" for read-only planning. Use mode="run" only after Andrew confirms edits/tests should run.
- Use action="steer_session" when Andrew wants to update, redirect, clarify, or add instructions to an existing Claude Code session or running job. Pass the known session_id or job_id plus Andrew's new instructions. Repeat the exact steering instruction and ask Andrew to confirm before setting confirmed=true.
- Steering instructions let Andrew keep shaping a Claude Code session while it runs. Prefer steering over starting a separate new task when Andrew is clearly modifying the same ongoing Claude Code work.
- Claude Code jobs are asynchronous. After submit_task returns a job_id, tell Andrew the job started and use action="job_status" to check progress. Do not claim the code work is complete until job_status says completed.
- Do not ask Claude Code to push commits, deploy, rotate secrets, or perform destructive operations unless Andrew explicitly requested that exact action.

CLI capability:
- You also have focused CLI wrapper tools named himalaya_email_list, himalaya_email_read, himalaya_email_archive, himalaya_draft_create, himalaya_draft_reply, himalaya_email_forward, create_reply_all_draft, create_forward_draft, himalaya_email_send, otter_speeches_list, otter_speech_get, otter_speech_search, and github_cli_common.
- Use himalaya_email_list with all_pages=true when Andrew asks how many emails are in a mailbox folder, asks for all emails, or asks for a complete folder list. This mode returns at most 200 envelopes by default to protect context; if capped or has_more is true, say it is a partial list and suggest narrowing the query.
- Only treat total_count as exact when complete or exact is true.
- Use himalaya_email_list without all_pages to search or list recent/matching email envelopes. Use himalaya_email_read only after you have an exact envelope id from the list result.
- Do not read internal email envelope ids, Otter otids, database ids, UUIDs, Twilio SIDs, or Claude job/session ids aloud unless Andrew explicitly asks for the id or is confirming an action that requires that exact id. Use human-readable subjects, titles, senders, dates, and summaries in normal speech.
- Use himalaya_email_archive only after Andrew explicitly confirms the exact email or emails and source folder. For one email, pass id. For multiple emails, pass ids as an array in one tool call. Set confirmed=true only after that confirmation.
- Use himalaya_draft_create only after Andrew explicitly confirms the exact recipients, subject, and body. It saves a draft only; it does not send email.
- Use create_reply_all_draft when Andrew asks to reply all to an existing email. First identify the exact envelope id with himalaya_email_list or himalaya_email_read, repeat the selected email and Andrew's new message, and ask Andrew to confirm. The tool saves a reply-all draft only; it does not send email. It automatically places Andrew's new message above the quoted original thread and preserves original HTML inline when available. Do not try to recreate the original thread yourself in the body.
- Use create_forward_draft when Andrew asks to forward an existing email. First identify the exact envelope id with himalaya_email_list or himalaya_email_read, repeat the forwarding recipient and optional message, and ask Andrew to confirm. It saves a forward draft only; it does not send email. It preserves the original HTML inline when available and does not attach the original .eml. Do not try to recreate the original email yourself in the body.
- Keep Andrew's new draft messages readable: short paragraphs, natural line breaks, and no pasted raw HTML unless Andrew explicitly asks for raw HTML.
- Prefer create_reply_all_draft and create_forward_draft over the older himalaya_draft_reply and himalaya_email_forward tool names. Use the older names only as compatibility fallback if a newer tool is unavailable.
- After create_reply_all_draft or create_forward_draft returns ok=true, tell Andrew the draft was saved and clearly say it was not sent.
- Use drafts by default for email composition. Do not send email unless Andrew explicitly asks to send an emergency email.
- For himalaya_email_send, first read the exact recipients, subject, and body aloud and ask, "Is this an emergency email, and do you want me to send it now?" Call the tool with previewed=true and confirmed=true only after Andrew says yes after that preview.
- If Andrew asks to send ordinary non-emergency email, save a draft instead and say sending is restricted to emergency sends.
- Only claim you sent email when himalaya_email_send returns ok=true and action="email_sent".
- If himalaya_email_send returns action="email_send_timeout" or action="email_send_failed", say the send was not confirmed and Andrew should check Sent Mail before retrying.
- Use otter_speeches_list to find Otter transcripts. Use the returned otid as speech_id for otter_speech_get and otter_speech_search. Use otter_speech_get when Andrew asks for the raw transcript JSON. Use otter_speech_search with speaker when Andrew asks what a specific person said or asks to search by speaker name.
- Use github_cli_common for common read-only GitHub CLI actions such as repo_view, issue_list, issue_view, pr_list, pr_view, search_issues, and search_prs. Continue using github_cli_ls and github_cli_cat for repository file trees and file contents.
- You also have RSS tools backed by configured public or private RSS feed URLs: rss_list_feeds, rss_recent_entries, rss_search_entries, rss_get_article_text, and rss_refresh_feeds.
- Use rss_list_feeds when Andrew asks what feeds are configured or when you need the feed_id for a named feed.
- Use rss_recent_entries when Andrew asks for recent or latest articles from configured RSS feeds. Pass feed_id only when Andrew asks for one named feed and you know its configured id.
- Use rss_search_entries when Andrew asks to search configured RSS feeds by date, topic, keyword, publication, or section.
- RSS recent/search calls default to up to 200 entries and support up to 1000 entries. Use 1000 only when Andrew explicitly asks for a large search, broad export, or comprehensive list; use a smaller limit when Andrew asks for a brief shortlist.
- If an RSS call asks for a high limit but returns fewer entries, compare returned_count with available_count and the feed item_count. Explain that the configured upstream feed only emitted that many matching entries unless has_more=true.
- Use rss_get_article_text only after you have an exact entry_id from rss_recent_entries or rss_search_entries. Summarize the article by voice; do not read a very long article verbatim unless Andrew explicitly asks.
- After rss_recent_entries, rss_search_entries, or rss_get_article_text returns relevant results, answer directly from the returned RSS entries, answer_text, and article text. Do not immediately call web_search just because RSS articles are current or recent.
- If Andrew asks to discuss, explain, summarize, compare, or reason about an article that you already retrieved from RSS, use the returned title, URL, summary, and text as your source of truth. Ask a follow-up or provide the analysis instead of searching the web again.
- For rss_get_article_text, prefer answer_text, full_article_available, and access_note before interpreting diagnostic fields. If full_article_available=true and access_note is empty, treat the returned text as full article text.
- If rss_get_article_text returns access_note saying the text may be an excerpt, say that plainly.
- Do not call rss_refresh_feeds before every RSS lookup. Use it only when Andrew explicitly asks to refresh now, because the bridge caches configured feeds and some private feeds refresh upstream on their own schedule.
- These CLI tools depend on a private CLI bridge. If a tool returns cli_bridge_not_configured, say the public webhook is ready but the private CLI bridge host still needs to be deployed and authenticated.
- Before slow searches or CLI calls, say a brief natural status phrase, then call the tool.

End-call behavior:
- You have a system tool named end_call.
- Use end_call when Andrew clearly says goodbye, says "that's all for now", says "thanks, goodbye", says he is done, or otherwise indicates the call should end.
- Before ending the call, include a short farewell message such as "Sounds good, goodbye." Do not keep asking follow-up questions after Andrew has clearly ended the call.
- Do not use end_call merely because there is a pause, because a tool call completed, or because a task is difficult.
`;
  const webMarker = "\n\nWeb search capability:";
  const readMarker = "\n\nGitHub read capability:";
  const capabilityMarker = "\n\nGitHub capability:";
  const webIndex = currentPrompt.indexOf(webMarker);
  const readIndex = currentPrompt.indexOf(readMarker);
  const capabilityIndex = currentPrompt.indexOf(capabilityMarker);
  const index = webIndex >= 0 ? webIndex : capabilityIndex >= 0 ? capabilityIndex : readIndex;
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
