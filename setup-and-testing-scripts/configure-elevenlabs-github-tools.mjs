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
  himalayaEmailSendToolConfig(),
  otterSpeechesListToolConfig(),
  otterSpeechGetToolConfig(),
  otterSpeechSearchToolConfig(),
  githubCliCommonToolConfig(),
  rssRecentEconomistEntriesToolConfig(),
  rssSearchEconomistEntriesToolConfig(),
  rssGetEconomistArticleTextToolConfig(),
  rssRefreshEconomistFeedsToolConfig(),
  conversationHistorySearchToolConfig(),
  conversationHistoryGetToolConfig(),
  claudeCodeToolConfig(),
];
const obsoleteToolNames = ["himalaya_email_count"];

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
const currentTtsConfig = conversationConfig.tts || {};
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
      "Refresh Phoneclaw tools and stabilize the configured voice",
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
      "Returns read-only summaries of open GitHub issues or pull requests visible to the GitHub CLI account authenticated on the private Phoneclaw bridge. Supports optional repo, owner, and organization filters.",
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

function rssRecentEconomistEntriesToolConfig() {
  return webhookTool({
    name: "rss_recent_economist_entries",
    description:
      "List recent Economist articles from the Miniflux RSS backend. Use when Andrew asks for recent Economist articles, latest Economist news, or updated Economist stories.",
    url: `${workerBaseUrl}/cli/rss/economist/recent`,
    required: [],
    responseTimeoutSecs: 20,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      limit: integerProperty({
        description: "Maximum articles to return. Use 5 by default for phone answers.",
      }),
      status: stringProperty({
        description:
          "Read status filter. Use all by default unless Andrew specifically asks for unread or read.",
        values: ["all", "unread", "read"],
      }),
    },
    responseDescription: "Recent Economist RSS entries.",
    responseProperties: rssEntriesResponseProperties(),
  });
}

function rssSearchEconomistEntriesToolConfig() {
  return webhookTool({
    name: "rss_search_economist_entries",
    description:
      "Search Economist articles from the Miniflux RSS backend by keyword and optional published date range.",
    url: `${workerBaseUrl}/cli/rss/economist/search`,
    required: ["query"],
    responseTimeoutSecs: 20,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      query: stringProperty({
        description: "Search query or keywords, for example AI, oil, China, tariffs.",
      }),
      start_date: stringProperty({
        description: "Optional inclusive published-after date or timestamp.",
      }),
      end_date: stringProperty({
        description: "Optional inclusive published-before date or timestamp.",
      }),
      limit: integerProperty({
        description: "Maximum articles to return. Use 5 by default for phone answers.",
      }),
      status: stringProperty({
        description:
          "Read status filter. Use all by default unless Andrew specifically asks for unread or read.",
        values: ["all", "unread", "read"],
      }),
    },
    responseDescription: "Economist RSS search results.",
    responseProperties: rssEntriesResponseProperties(),
  });
}

function rssGetEconomistArticleTextToolConfig() {
  return webhookTool({
    name: "rss_get_economist_article_text",
    description:
      "Fetch readable full text for a specific Economist article entry id returned by rss_recent_economist_entries or rss_search_economist_entries. Prefers the secure RSS-Bridge full-text feed when available, then falls back to Miniflux and the authenticated browser fetcher.",
    url: `${workerBaseUrl}/cli/rss/economist/article-text`,
    required: ["entry_id"],
    responseTimeoutSecs: 45,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      entry_id: integerProperty({
        description:
          "Economist entry id from a recent/search result. This may be a Miniflux id or a virtual RSS-Bridge id.",
      }),
      article_url: stringProperty({
        description:
          "Optional Economist article URL when an entry id is not available.",
      }),
      fetch_original: booleanProperty(
        "Set true by default to ask Miniflux to fetch the original article content."
      ),
      update_content: booleanProperty(
        "Set true by default so Miniflux caches the fetched original content."
      ),
      max_text_chars: integerProperty({
        description:
          "Maximum article text characters to return. Use 30000 by default; lower for short phone summaries.",
      }),
    },
    responseDescription: "Economist article text.",
    responseProperties: {
      ok: booleanProperty("Whether article text retrieval succeeded."),
      status: stringProperty({ description: "Status code." }),
      answer_text: stringProperty({
        description:
          "Compact spoken summary of the final article retrieval result. Prefer this before diagnostic status fields.",
      }),
      full_article_available: booleanProperty(
        "True when the final returned content should be treated as full article text."
      ),
      provider: stringProperty({ description: "RSS backend provider." }),
      source: stringProperty({ description: "Article source." }),
      entry_id: integerProperty({ description: "Miniflux entry id." }),
      content_source: stringProperty({
        description:
          "economist_rss_bridge, stored_entry_content, original_article_fetch, or economist_browser_fetch.",
      }),
      original_fetch_status: stringProperty({ description: "Status of original-content fetch." }),
      original_fetch_message: stringProperty({
        description: "Error message when original-content fetch failed.",
      }),
      rss_bridge_fetch_status: stringProperty({
        description: "Status of secure RSS-Bridge full-text fetch.",
      }),
      rss_bridge_fetch_message: stringProperty({
        description: "RSS-Bridge message or reason it did not match the requested article.",
      }),
      rss_bridge_url: stringProperty({
        description: "Redacted RSS-Bridge feed URL used for the request.",
      }),
      browser_fetch_status: stringProperty({
        description: "Status of authenticated browser fallback fetch.",
      }),
      browser_fetch_message: stringProperty({
        description: "Browser fallback message or reason it did not return full text.",
      }),
      browser_fetch_url: stringProperty({
        description: "Final URL visited by the browser fallback.",
      }),
      full_text_chars: integerProperty({ description: "Full extracted text length." }),
      returned_text_chars: integerProperty({ description: "Returned text length." }),
      full_text_truncated: booleanProperty("Whether full_text was truncated."),
      full_text: stringProperty({
        description:
          "Readable article text. Summarize by voice; do not read the entire article unless Andrew asks.",
      }),
      access_note: stringProperty({
        description:
          "Note when the returned text appears to be an excerpt or needs authenticated access.",
      }),
      entry: objectProperty({
        description: "Article metadata.",
        properties: rssEntryProperties(),
      }),
    },
  });
}

function rssRefreshEconomistFeedsToolConfig() {
  return webhookTool({
    name: "rss_refresh_economist_feeds",
    description:
      "Refresh the Economist feed category in Miniflux. Use before listing recent articles when Andrew asks for the latest possible results.",
    url: `${workerBaseUrl}/cli/rss/economist/refresh`,
    required: [],
    responseTimeoutSecs: 20,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {},
    responseDescription: "Economist RSS refresh response.",
    responseProperties: {
      ok: booleanProperty("Whether refresh was started."),
      status: stringProperty({ description: "Status code." }),
      provider: stringProperty({ description: "RSS backend provider." }),
      source: stringProperty({ description: "Feed source." }),
      category_id: integerProperty({ description: "Miniflux category id." }),
      category_title: stringProperty({ description: "Miniflux category title." }),
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
      "Search archived Phoneclaw phone conversations by keyword and optional date range. Returns compact hundred-word summaries and keywords, not full transcripts.",
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
      "Fetch compact details for a specific archived Phoneclaw conversation_id returned by conversation_history_search. Returns a capped transcript excerpt by default to avoid overloading the live call.",
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
      "Explicit escalation tool for Claude Code running on the private EC2 bridge. Use only when Andrew asks to use Claude Code, asks to start/check a Claude Code session, or confirms that a complex code change/test run should be delegated.",
    url: `${workerBaseUrl}/cli/claude-code`,
    required: ["action"],
    responseTimeoutSecs: 20,
    forcePreToolSpeech: true,
    toolCallSound: "typing",
    requestProperties: {
      action: stringProperty({
        description:
          "Action to run: auth_status checks Claude auth; start_session creates a session id; submit_task starts an async Claude Code job; job_status checks an existing job.",
        values: ["auth_status", "start_session", "submit_task", "job_status"],
      }),
      task: stringProperty({
        description:
          "Task for Claude Code. Required for submit_task. Include the exact repository/task Andrew confirmed.",
      }),
      repo_path: stringProperty({
        description:
          "Optional absolute repository path on the EC2 bridge. Omit for the default Phoneclaw repo.",
      }),
      session_id: stringProperty({
        description:
          "Optional Claude Code session UUID. Reuse this to continue the same Claude Code conversation.",
      }),
      job_id: stringProperty({
        description: "Claude Code job UUID to check with action=job_status.",
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
          "Status such as ok, session_ready, running, completed, failed, claude_not_authenticated, confirmation_required, or job_not_found.",
      }),
      action: stringProperty({ description: "Action performed." }),
      authenticated: booleanProperty("Whether Claude Code is authenticated on the bridge."),
      auth_method: stringProperty({ description: "Claude Code auth method when known." }),
      session_id: stringProperty({ description: "Claude Code session UUID." }),
      job_id: stringProperty({ description: "Claude Code async job UUID." }),
      mode: stringProperty({ description: "Claude Code mode: plan or run." }),
      working_directory: stringProperty({ description: "Repository path used on the bridge." }),
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
    source: stringProperty({ description: "Feed source." }),
    query: stringProperty({ description: "Search query when applicable." }),
    start_date: stringProperty({ description: "Start date when applicable." }),
    end_date: stringProperty({ description: "End date when applicable." }),
    returned_count: integerProperty({ description: "Number of entries returned." }),
    total_count: integerProperty({ description: "Total matching entries if reported by Miniflux." }),
    category_id: integerProperty({ description: "Miniflux category id." }),
    category_title: stringProperty({ description: "Miniflux category title." }),
    answer_text: stringProperty({
      description: "Compact spoken summary. Prefer this before reading item details.",
    }),
    items: arrayProperty({
      description: "Economist article entries.",
      itemDescription: "One Economist article entry.",
      properties: rssEntryProperties(),
    }),
  };
}

function rssEntryProperties() {
  return {
    id: integerProperty({ description: "Miniflux entry id." }),
    title: stringProperty({ description: "Article title." }),
    url: stringProperty({ description: "Article URL." }),
    author: stringProperty({ description: "Article author." }),
    published_at: stringProperty({ description: "Published timestamp." }),
    created_at: stringProperty({ description: "Miniflux created timestamp." }),
    changed_at: stringProperty({ description: "Miniflux changed timestamp." }),
    status: stringProperty({ description: "Read status." }),
    starred: booleanProperty("Whether the article is starred."),
    reading_time: integerProperty({ description: "Estimated reading time." }),
    feed_id: integerProperty({ description: "Miniflux feed id." }),
    feed_title: stringProperty({ description: "Feed title." }),
    feed_url: stringProperty({ description: "Feed URL." }),
    category_title: stringProperty({ description: "Category title." }),
    content_source: stringProperty({
      description: "Optional source hint such as economist_rss_bridge.",
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
    original_has_plain: booleanProperty("Whether the forwarded original email had a plain-text body."),
    attached_original_eml: booleanProperty("Always false for forward drafts; the original email is included inline, not attached as an .eml."),
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
- At the start of a call, the dynamic variable recent_conversation_context may contain compact summaries of recent archived Phoneclaw conversations. Use it quietly as background context; do not read it aloud unless Andrew asks what context you have.
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
- You have a webhook tool named claude_code that can check auth, start a session, submit an async Claude Code job on EC2, and check job status.
- Do not use Claude Code by default. First solve directly with conversation, web_search, GitHub, email, or Otter tools when that is enough.
- Use claude_code only when Andrew explicitly asks to use Claude Code, asks to start/check a Claude Code session, or confirms that a complex code change or test run should be delegated to Claude Code.
- Use action="auth_status" when Andrew asks whether Claude Code is ready.
- Use action="start_session" when Andrew asks to start a Claude Code session. Remember and reuse the returned session_id.
- Before action="submit_task", repeat the exact repository/path and task, then ask Andrew to confirm. Set confirmed=true only after that confirmation.
- Use mode="plan" for read-only planning. Use mode="run" only after Andrew confirms edits/tests should run.
- Claude Code jobs are asynchronous. After submit_task returns a job_id, tell Andrew the job started and use action="job_status" to check progress. Do not claim the code work is complete until job_status says completed.
- Do not ask Claude Code to push commits, deploy, rotate secrets, or perform destructive operations unless Andrew explicitly requested that exact action.

CLI capability:
- You also have focused CLI wrapper tools named himalaya_email_list, himalaya_email_read, himalaya_email_archive, himalaya_draft_create, himalaya_draft_reply, himalaya_email_forward, himalaya_email_send, otter_speeches_list, otter_speech_get, otter_speech_search, and github_cli_common.
- Use himalaya_email_list with all_pages=true when Andrew asks how many emails are in a mailbox folder, asks for all emails, or asks for a complete folder list. This mode returns at most 200 envelopes by default to protect context; if capped or has_more is true, say it is a partial list and suggest narrowing the query.
- Only treat total_count as exact when complete or exact is true.
- Use himalaya_email_list without all_pages to search or list recent/matching email envelopes. Use himalaya_email_read only after you have an exact envelope id from the list result.
- Do not read internal email envelope ids, Otter otids, database ids, UUIDs, Twilio SIDs, or Claude job/session ids aloud unless Andrew explicitly asks for the id or is confirming an action that requires that exact id. Use human-readable subjects, titles, senders, dates, and summaries in normal speech.
- Use himalaya_email_archive only after Andrew explicitly confirms the exact email or emails and source folder. For one email, pass id. For multiple emails, pass ids as an array in one tool call. Set confirmed=true only after that confirmation.
- Use himalaya_draft_create only after Andrew explicitly confirms the exact recipients, subject, and body. It saves a draft only; it does not send email.
- Use himalaya_draft_reply only after Andrew explicitly confirms the exact envelope id and reply body. It saves a reply draft only; it does not send email.
- Use himalaya_email_forward when Andrew asks to forward an existing email. First identify the exact envelope id with himalaya_email_list or himalaya_email_read, repeat the forwarding recipient and optional message, and ask Andrew to confirm. It saves a forward draft only; it does not send email. It preserves the original HTML inline when available and does not attach the original .eml.
- After himalaya_email_forward returns ok=true, tell Andrew the forward draft was saved and clearly say it was not sent.
- Use drafts by default for email composition. Do not send email unless Andrew explicitly asks to send an emergency email.
- For himalaya_email_send, first read the exact recipients, subject, and body aloud and ask, "Is this an emergency email, and do you want me to send it now?" Call the tool with previewed=true and confirmed=true only after Andrew says yes after that preview.
- If Andrew asks to send ordinary non-emergency email, save a draft instead and say sending is restricted to emergency sends.
- Only claim you sent email when himalaya_email_send returns ok=true and action="email_sent".
- If himalaya_email_send returns action="email_send_timeout" or action="email_send_failed", say the send was not confirmed and Andrew should check Sent Mail before retrying.
- Use otter_speeches_list to find Otter transcripts. Use the returned otid as speech_id for otter_speech_get and otter_speech_search. Use otter_speech_get when Andrew asks for the raw transcript JSON. Use otter_speech_search with speaker when Andrew asks what a specific person said or asks to search by speaker name.
- Use github_cli_common for common read-only GitHub CLI actions such as repo_view, issue_list, issue_view, pr_list, pr_view, search_issues, and search_prs. Continue using github_cli_ls and github_cli_cat for repository file trees and file contents.
- You also have RSS tools backed by Miniflux: rss_recent_economist_entries, rss_search_economist_entries, rss_get_economist_article_text, and rss_refresh_economist_feeds.
- Use rss_recent_economist_entries when Andrew asks for recent or latest Economist articles.
- Use rss_search_economist_entries when Andrew asks to search Economist articles by date, topic, keyword, or section.
- Use rss_get_economist_article_text only after you have an exact entry_id from recent/search results. Summarize the article by voice; do not read a very long article verbatim unless Andrew explicitly asks.
- For rss_get_economist_article_text, prefer answer_text and full_article_available before interpreting diagnostic fetch status fields. If full_article_available=true and access_note is empty, say the final result is full article text even if intermediate RSS-Bridge or Miniflux diagnostic fields mention failures.
- If rss_get_economist_article_text returns content_source="economist_rss_bridge", full Economist article text was fetched through the secure RSS-Bridge feed. Treat it as full text unless access_note says otherwise.
- If rss_get_economist_article_text returns content_source="economist_browser_fetch", full subscriber text was fetched through the authenticated bridge browser. Summarize it by voice instead of reading the article verbatim.
- If rss_get_economist_article_text returns an access_note saying the text may be an excerpt or needs authenticated access, say that plainly. If browser_fetch_status indicates login or Cloudflare, say the EC2 browser profile needs to be authenticated.
- Use rss_refresh_economist_feeds before listing when Andrew asks for the latest possible Economist results.
- These CLI tools depend on a private CLI bridge. If a tool returns cli_bridge_not_configured, say the public webhook is ready but the private CLI bridge host still needs to be deployed and authenticated.
- Before slow searches or CLI calls, say a brief natural status phrase, then call the tool.`;
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
