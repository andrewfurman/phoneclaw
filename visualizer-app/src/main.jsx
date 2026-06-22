import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import "./styles.css";

const AUTO_REFRESH_MS = 5000;

function App() {
  return (
    <BrowserRouter basename="/visualizer">
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/conversation/:conversationId" element={<Dashboard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function Dashboard() {
  const navigate = useNavigate();
  const { conversationId } = useParams();
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState("latest");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [bootstrap, setBootstrap] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");

  const loadBootstrap = async () => {
    const params = new URLSearchParams({ limit: "14" });
    if (submittedQuery) params.set("query", submittedQuery);

    setError("");
    const data = await requestJson(`/visualizer/api/bootstrap?${params}`);
    setBootstrap(data);
    setLoading(false);

    const nextId = conversationId || mergedConversations(data)[0]?.conversation_id;
    if (!conversationId && nextId) {
      navigate(`/conversation/${encodeURIComponent(nextId)}`, { replace: true });
    }
  };

  const loadConversationDetail = async (id, { showLoading = false } = {}) => {
    if (!id) return;
    if (showLoading) setDetailLoading(true);
    try {
      const data = await requestJson(`/visualizer/api/conversations/${encodeURIComponent(id)}`);
      setSelected(data.conversation || null);
    } finally {
      if (showLoading) setDetailLoading(false);
    }
  };

  useEffect(() => {
    loadBootstrap().catch((err) => {
      setLoading(false);
      setError(err.message);
    });
  }, [submittedQuery]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(() => {
      loadBootstrap().catch((err) => setError(err.message));
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, submittedQuery, conversationId]);

  const conversations = useMemo(() => mergedConversations(bootstrap), [bootstrap]);
  const latestConversation = conversations[0] || null;
  const latestConversationId = latestConversation?.conversation_id || "";
  const effectiveConversationId =
    isMobile && mobileView === "latest"
      ? latestConversationId
      : conversationId || latestConversationId;
  const listConversations =
    isMobile && mobileView === "archive" ? conversations.slice(1) : conversations;
  const summaryConversation =
    conversations.find((item) => item.conversation_id === effectiveConversationId) || null;
  const selectedConversation =
    selected?.conversation_id === effectiveConversationId
      ? mergeSelectedConversation(summaryConversation, selected)
      : summaryConversation;
  const twilioEvents = bootstrap?.twilio_events?.events || [];
  const selectedEvents = selectedConversation?.twilio_call_sid
    ? twilioEvents.filter((event) => event.call_sid === selectedConversation.twilio_call_sid)
    : twilioEvents;
  const toolItems = allToolItems(selectedConversation);
  const quickLinks = extractQuickLinks(selectedConversation);
  const health = bootstrap?.health || {};

  const onSearchSubmit = (event) => {
    event.preventDefault();
    setSubmittedQuery(query.trim());
  };

  useEffect(() => {
    if (!isMobile || mobileView !== "latest" || !latestConversationId) return;
    if (conversationId !== latestConversationId) {
      navigate(`/conversation/${encodeURIComponent(latestConversationId)}`, { replace: true });
    }
  }, [conversationId, isMobile, latestConversationId, mobileView, navigate]);

  useEffect(() => {
    if (!effectiveConversationId) {
      setSelected(null);
      return undefined;
    }

    let cancelled = false;
    setDetailLoading(true);
    requestJson(`/visualizer/api/conversations/${encodeURIComponent(effectiveConversationId)}`)
      .then((data) => {
        if (!cancelled) setSelected(data.conversation || null);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveConversationId]);

  useEffect(() => {
    if (!autoRefresh || !effectiveConversationId) return undefined;
    const timer = setInterval(() => {
      loadConversationDetail(effectiveConversationId).catch((err) => setError(err.message));
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, effectiveConversationId]);

  return (
    <main className={`app-shell mobile-${mobileView}`}>
      <header className="topbar">
        <div>
          <div className="eyebrow">Phoneclaw</div>
          <h1>Live demo console</h1>
        </div>
        <div className="topbar-actions">
          <StatusPill label="Bridge" ok={health.cli_bridge_configured} />
          <StatusPill label="Events" ok={health.twilio_event_log_configured} />
          <label className="switch">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            <span>Live</span>
          </label>
          <button className="icon-button" type="button" title="Refresh" onClick={loadBootstrap}>
            Refresh
          </button>
          <a className="logout-link" href="/visualizer/logout">
            Logout
          </a>
        </div>
      </header>

      <nav className="mobile-tabs" aria-label="Mobile visualizer views">
        <button
          className={mobileView === "latest" ? "active" : ""}
          type="button"
          onClick={() => {
            setMobileView("latest");
            if (latestConversationId) {
              navigate(`/conversation/${encodeURIComponent(latestConversationId)}`, { replace: true });
            }
          }}
        >
          Latest conversation
        </button>
        <button
          className={mobileView === "archive" ? "active" : ""}
          type="button"
          onClick={() => setMobileView("archive")}
        >
          Archive
        </button>
      </nav>

      <section className="toolbar" aria-label="Conversation filters">
        <form className="search-form" onSubmit={onSearchSubmit}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search summaries, transcripts, keywords"
          />
          <button type="submit">Search</button>
        </form>
        <button
          className="secondary-button"
          type="button"
          onClick={() =>
            requestJson("/visualizer/api/archive-latest", { method: "POST" })
              .then(loadBootstrap)
              .catch((err) => setError(err.message))
          }
        >
          Archive latest
        </button>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className={`workspace mobile-${mobileView}`}>
        <aside className="conversation-list" aria-label="Conversations">
          <div className="panel-heading">
            <h2>{isMobile && mobileView === "archive" ? "Archived conversations" : "Recent calls"}</h2>
            <span>{loading ? "Loading" : `${listConversations.length} shown`}</span>
          </div>
          <div className="list-items">
            {listConversations.map((conversation) => (
              <ConversationListItem
                key={`${conversation.source}-${conversation.conversation_id}`}
                conversation={conversation}
                selected={conversation.conversation_id === effectiveConversationId}
              />
            ))}
            {!loading && listConversations.length === 0 ? (
              <div className="empty-state">
                {isMobile && mobileView === "archive"
                  ? "No archived conversations beyond the latest call yet."
                  : "No conversations found."}
              </div>
            ) : null}
          </div>
        </aside>

        <section className="conversation-detail" aria-label="Selected conversation">
          {selectedConversation ? (
            <>
              <ConversationHeader conversation={selectedConversation} loading={detailLoading} />
              <OverviewStrip
                conversation={selectedConversation}
                toolItems={toolItems}
                quickLinks={quickLinks}
                events={selectedEvents}
              />
              <div className="detail-grid">
                <section className="transcript-panel">
                  <div className="panel-heading">
                    <h2>Live transcript</h2>
                    <span>{turnsFor(selectedConversation).length} turns</span>
                  </div>
                  <Transcript conversation={selectedConversation} />
                </section>
                <aside className="side-panel">
                  <QuickLinksPanel links={quickLinks} />
                  <ToolCalls items={toolItems} />
                  <TwilioEvents events={selectedEvents} />
                </aside>
              </div>
            </>
          ) : (
            <div className="empty-detail">Select a conversation.</div>
          )}
        </section>
      </section>
    </main>
  );
}

function ConversationListItem({ conversation, selected }) {
  const links = extractQuickLinks(conversation);
  return (
    <Link
      className={`conversation-row ${selected ? "selected" : ""}`}
      to={`/conversation/${encodeURIComponent(conversation.conversation_id)}`}
    >
      <div className="row-title">
        <span>{conversationLabel(conversation)}</span>
        <Badge value={conversation.source === "live" ? "live" : "archive"} />
      </div>
      <div className="row-meta">
        <span>{formatDateTime(conversation.started_at || conversation.updated_at)}</span>
        <span>{conversation.status || "unknown"}</span>
        <span>{toolCount(conversation)} tools</span>
        {links.length ? <span>{links.length} links</span> : null}
      </div>
      {conversation.summary ? <p>{conversation.summary}</p> : null}
    </Link>
  );
}

function ConversationHeader({ conversation, loading }) {
  return (
    <header className="detail-header">
      <div>
        <div className="eyebrow">{conversation.source === "live" ? "ElevenLabs live" : "Archive"}</div>
        <h2>{conversationLabel(conversation)}</h2>
        <div className="header-meta">
          <span>{formatDateTime(conversation.started_at || conversation.updated_at)}</span>
          <span>{conversation.status || "unknown"}</span>
          {conversation.duration_seconds != null ? (
            <span>{formatDuration(conversation.duration_seconds)}</span>
          ) : null}
          {conversation.twilio_call_sid ? <span>{conversation.twilio_call_sid}</span> : null}
        </div>
      </div>
      {loading ? <Badge value="syncing" /> : <Badge value={conversation.status || "loaded"} />}
    </header>
  );
}

function OverviewStrip({ conversation, toolItems, quickLinks, events }) {
  const latestTurn = turnsFor(conversation).findLast((turn) => realText(turn.message));
  return (
    <section className="overview-strip" aria-label="Conversation overview">
      <MetricCard label="Transcript" value={`${turnsFor(conversation).length}`} detail="turns" />
      <MetricCard
        label="Tools"
        value={`${toolItems.filter((item) => item.type === "call").length}`}
        detail={`${toolItems.filter((item) => item.type === "result").length} results`}
      />
      <MetricCard label="Links" value={`${quickLinks.length}`} detail={linkTypeSummary(quickLinks)} />
      <MetricCard label="Events" value={`${events.length}`} detail="Twilio log" />
      <div className="now-card">
        <span>Latest spoken turn</span>
        <p>{latestTurn?.message || "Waiting for the next live update."}</p>
      </div>
    </section>
  );
}

function MetricCard({ label, value, detail }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function Transcript({ conversation }) {
  const turns = turnsFor(conversation);
  if (turns.length === 0) return <div className="empty-state">No transcript yet.</div>;

  return (
    <div className="transcript">
      {turns.map((turn, index) => (
        <article className={`turn ${turn.role || "event"}`} key={turn.id || index}>
          <div className="turn-meta">
            <div className="turn-role">{turn.role || "event"}</div>
            <time>{formatLocalTime(timestampForTurn(turn, conversation))}</time>
          </div>
          <div className="turn-body">
            {turn.message ? <p>{turn.message}</p> : <p className="muted">No spoken text.</p>}
            {Array.isArray(turn.tool_calls) && turn.tool_calls.length > 0 ? (
              <div className="inline-tools">
                {turn.tool_calls.map((call, callIndex) => (
                  <ToolCallCard
                    item={normalizeToolItem(call, "call", turn, conversation)}
                    key={call.id || callIndex}
                  />
                ))}
              </div>
            ) : null}
            {Array.isArray(turn.tool_results) && turn.tool_results.length > 0 ? (
              <div className="inline-tools">
                {turn.tool_results.map((result, resultIndex) => (
                  <ToolCallCard
                    item={normalizeToolItem(result, "result", turn, conversation)}
                    key={result.id || resultIndex}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function ToolCalls({ items }) {
  return (
    <section className="tool-panel">
      <div className="panel-heading">
        <h2>Tool activity</h2>
        <span>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="empty-state">No tool calls recorded.</div>
      ) : (
        <div className="tool-stack">
          {items.map((item, index) => (
            <ToolCallCard item={item} key={`${item.type}-${item.name}-${index}`} />
          ))}
        </div>
      )}
    </section>
  );
}

function ToolCallCard({ item }) {
  return (
    <div className={`tool-card ${item.type}`}>
      <div className="tool-card-header">
        <span>{displayToolName(item.name)}</span>
        <div className="tool-card-meta">
          <time>{formatLocalTime(item.happenedAt)}</time>
          <Badge value={item.type} />
        </div>
      </div>
      <div className="tool-summary">{toolSummary(item)}</div>
      {item.links.length ? <LinkChips links={item.links} compact /> : null}
      <details className="payload-details">
        <summary>Payload</summary>
        <pre>{JSON.stringify(item.preview, null, 2)}</pre>
      </details>
    </div>
  );
}

function QuickLinksPanel({ links }) {
  const groups = groupLinks(links);
  return (
    <section className="quick-links-panel">
      <div className="panel-heading">
        <h2>Action links</h2>
        <span>{links.length}</span>
      </div>
      {links.length === 0 ? (
        <div className="empty-state">No GitHub, Gmail, or article links found yet.</div>
      ) : (
        <div className="quick-link-groups">
          {groups.map((group) => (
            <div className="quick-link-group" key={group.label}>
              <h3>{group.label}</h3>
              <LinkChips links={group.links} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function LinkChips({ links, compact = false }) {
  return (
    <div className={`link-chips ${compact ? "compact" : ""}`}>
      {links.map((link, index) => (
        <a
          className={`link-chip ${link.type}`}
          href={link.href}
          target="_blank"
          rel="noreferrer"
          key={`${link.href}-${index}`}
        >
          <span>{link.label}</span>
          {link.detail ? <small>{link.detail}</small> : null}
        </a>
      ))}
    </div>
  );
}

function TwilioEvents({ events }) {
  return (
    <section className="events-panel">
      <div className="panel-heading">
        <h2>Call events</h2>
        <span>{events.length}</span>
      </div>
      {events.length === 0 ? (
        <div className="empty-state">No recent Twilio events.</div>
      ) : (
        <div className="events-list">
          {events.map((event) => (
            <div className="event-row" key={event.id || `${event.received_at}-${event.event_type}`}>
              <div>
                <strong>{event.event_type || event.stream_event || event.call_status}</strong>
                <span>{formatDateTime(event.received_at)}</span>
              </div>
              <small>{event.call_sid || event.stream_sid || event.source}</small>
              {event.stream_error ? <p>{event.stream_error}</p> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function StatusPill({ label, ok }) {
  return <span className={`status-pill ${ok ? "ok" : "warn"}`}>{label}</span>;
}

function Badge({ value }) {
  return <span className="badge">{value}</span>;
}

function mergedConversations(data) {
  if (!data) return [];
  const map = new Map();
  for (const item of data.archived_conversations?.items || []) {
    if (item?.conversation_id) {
      map.set(item.conversation_id, { ...item, source: "archive" });
    }
  }
  for (const item of data.live_conversations?.items || []) {
    if (item?.conversation_id) {
      map.set(item.conversation_id, { ...map.get(item.conversation_id), ...item, source: "live" });
    }
  }
  return [...map.values()].sort((left, right) =>
    String(right.started_at || right.updated_at || "").localeCompare(
      String(left.started_at || left.updated_at || "")
    )
  );
}

function mergeSelectedConversation(summary, detail) {
  if (!summary) return detail;
  if (!detail) return summary;
  return {
    ...summary,
    ...detail,
    started_at: detail.started_at || summary.started_at,
    updated_at: detail.updated_at || summary.updated_at,
    ended_at: detail.ended_at || summary.ended_at,
    duration_seconds: detail.duration_seconds ?? summary.duration_seconds,
    status: detail.status || summary.status,
    source: detail.source || summary.source,
  };
}

function turnsFor(conversation) {
  return (
    conversation?.transcript ||
    conversation?.transcript_excerpt ||
    conversation?.details?.transcript ||
    []
  );
}

function allToolItems(conversation) {
  const turns = turnsFor(conversation);
  const items = [];
  for (const turn of turns) {
    for (const call of turn.tool_calls || []) {
      items.push(normalizeToolItem(call, "call", turn, conversation));
    }
    for (const result of turn.tool_results || []) {
      items.push(normalizeToolItem(result, "result", turn, conversation));
    }
  }
  for (const call of conversation?.tool_calls || []) {
    items.push(normalizeToolItem(call, "call", turnForToolItem(call, turns), conversation));
  }
  for (const result of conversation?.tool_results || []) {
    items.push(normalizeToolItem(result, "result", turnForToolItem(result, turns), conversation));
  }
  return dedupeToolItems(items);
}

function normalizeToolItem(item, type, turn, conversation) {
  const parsedParams = parseJson(item.params_as_json || item.params || item.parameters || {});
  const parsedResult = parseJson(item.result_value || item.result || item.value || {});
  const raw = type === "result" ? parsedResult : parsedParams;
  const name = item.tool_name || item.name || parsedResult?.tool_name || "";
  const normalized = {
    type,
    name,
    action: parsedResult?.action || parsedParams?.action || "",
    raw,
    preview: compactPreview(raw),
    happenedAt: timestampForToolItem(item, turn, conversation),
    latencySeconds: item.tool_latency_secs ?? null,
    links: [],
  };
  normalized.links = extractToolLinks(normalized);
  return normalized;
}

function turnForToolItem(item, turns) {
  const index = Number(item?.transcript_index ?? item?.turn_index);
  if (Number.isInteger(index) && index >= 0 && index < turns.length) return turns[index];
  if (item?.request_id) {
    return turns.find((turn) =>
      [...(turn.tool_calls || []), ...(turn.tool_results || [])].some(
        (toolItem) => toolItem.request_id === item.request_id
      )
    );
  }
  return null;
}

function dedupeToolItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.type}:${item.name}:${JSON.stringify(item.preview).slice(0, 500)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractQuickLinks(conversation) {
  return dedupeLinks(allToolItems(conversation).flatMap((item) => item.links));
}

function extractToolLinks(item) {
  const links = [];
  const raw = item.raw || {};
  const objects = collectObjects(raw);

  for (const object of objects) {
    const url = firstString(
      object.url,
      object.html_url,
      object.web_url,
      object.article_url,
      object.external_url,
      object.link
    );
    if (!url || !isHttpUrl(url)) continue;

    if (isGithubIssueUrl(url)) {
      links.push({
        type: "github_issue",
        label: githubIssueLabel(object, url),
        detail: object.repo || "GitHub issue",
        href: url,
      });
      continue;
    }

    if (isGithubUrl(url)) {
      links.push({
        type: "github",
        label: object.title || object.name || "Open GitHub",
        detail: object.repo || "GitHub",
        href: url,
      });
      continue;
    }

    if (isEconomistUrl(url)) {
      links.push({
        type: "economist_article",
        label: object.title || object.name || "Open Economist article",
        detail: formatDateTime(object.published_at || object.date || object.created_at),
        href: url,
      });
    }
  }

  const action = raw.action || item.action || "";
  if (["draft_created", "reply_draft_created", "forward_draft_created"].includes(action)) {
    const subject = raw.subject || "";
    links.push({
      type: "gmail_draft",
      label: draftLabel(action),
      detail: subject || raw.draft_id || "Gmail drafts",
      href: gmailDraftSearchHref(subject),
    });
  }

  return dedupeLinks(links);
}

function collectObjects(value, depth = 0) {
  if (depth > 4 || value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectObjects(item, depth + 1));
  if (typeof value !== "object") return [];

  const nestedKeys = [
    "issue",
    "pull_request",
    "entry",
    "article",
    "items",
    "articles",
    "results",
    "entries",
  ];
  const nested = nestedKeys.flatMap((key) => collectObjects(value[key], depth + 1));
  return [value, ...nested];
}

function compactPreview(value) {
  if (value == null || typeof value !== "object") return compactPrimitive(value);
  if (Array.isArray(value)) return value.slice(0, 4).map((item) => compactPreview(item));

  const output = {};
  const preferred = [
    "action",
    "status",
    "ok",
    "provider",
    "source",
    "repo",
    "path",
    "query",
    "to",
    "cc",
    "bcc",
    "subject",
    "id",
    "draft_id",
    "entry_id",
    "returned_count",
    "total_count",
    "content_source",
    "full_text_chars",
    "answer_text",
    "error",
    "message",
  ];

  for (const key of preferred) {
    if (value[key] != null && value[key] !== "") output[key] = compactPrimitive(value[key]);
  }

  if (value.issue && typeof value.issue === "object") output.issue = compactLinkedObject(value.issue);
  if (value.entry && typeof value.entry === "object") output.entry = compactLinkedObject(value.entry);
  if (Array.isArray(value.items)) {
    output.items = value.items.slice(0, 4).map((item) => compactLinkedObject(item));
  }

  if (Object.keys(output).length) return output;

  for (const [key, item] of Object.entries(value).slice(0, 14)) {
    if (["full_text", "content", "raw_json", "raw_message", "result_value"].includes(key)) continue;
    output[key] = compactPrimitive(item);
  }
  return output;
}

function compactLinkedObject(value) {
  if (!value || typeof value !== "object") return compactPrimitive(value);
  const keys = [
    "title",
    "name",
    "number",
    "state",
    "repo",
    "url",
    "html_url",
    "article_url",
    "published_at",
    "entry_id",
    "id",
    "author",
    "source",
  ];
  const output = {};
  for (const key of keys) {
    if (value[key] != null && value[key] !== "") output[key] = compactPrimitive(value[key]);
  }
  return Object.keys(output).length ? output : compactPreview(value);
}

function compactPrimitive(value) {
  if (typeof value !== "string") return value;
  return value.length > 700 ? `${value.slice(0, 700)}...` : value;
}

function groupLinks(links) {
  const labels = {
    github_issue: "GitHub issues",
    github: "GitHub",
    gmail_draft: "Gmail drafts",
    economist_article: "Economist articles",
  };
  const order = ["github_issue", "gmail_draft", "economist_article", "github"];
  const groups = [];
  for (const type of order) {
    const groupLinksForType = links.filter((link) => link.type === type);
    if (groupLinksForType.length) groups.push({ label: labels[type], links: groupLinksForType });
  }
  const other = links.filter((link) => !order.includes(link.type));
  if (other.length) groups.push({ label: "Other links", links: other });
  return groups;
}

function dedupeLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    if (!link?.href) return false;
    const key = `${link.type}:${link.href}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toolSummary(item) {
  const value = item.raw || {};
  if (item.type === "call") {
    const target = value.query || value.repo || value.to || value.subject || value.entry_id || value.path || "";
    return target ? `Requested ${displayToolName(item.name)} for ${target}.` : `Requested ${displayToolName(item.name)}.`;
  }

  if (value.issue?.url) {
    return `${capitalize(value.action || "created")} GitHub issue #${value.issue.number}: ${value.issue.title || ""}`;
  }
  if (["draft_created", "reply_draft_created", "forward_draft_created"].includes(value.action)) {
    return `${draftLabel(value.action)} saved${value.subject ? `: ${value.subject}` : ""}.`;
  }
  if (item.name?.startsWith("rss_") && Array.isArray(value.items)) {
    return `Returned ${value.items.length} Economist article${value.items.length === 1 ? "" : "s"}.`;
  }
  if (item.name === "rss_get_economist_article_text") {
    return `Fetched ${value.full_text_chars || 0} characters from ${value.entry?.title || "the article"}.`;
  }
  if (value.answer_text) return value.answer_text;
  if (value.status) return `Finished with status ${value.status}.`;
  return "Tool result received.";
}

function displayToolName(value) {
  return String(value || "tool").replaceAll("_", " ");
}

function conversationLabel(conversation) {
  return (
    conversation?.summary?.split(".")[0]?.slice(0, 90) ||
    conversation?.conversation_id ||
    "Conversation"
  );
}

function toolCount(conversation) {
  return conversation?.tool_call_count ?? allToolItems(conversation).filter((item) => item.type === "call").length;
}

function linkTypeSummary(links) {
  if (!links.length) return "none yet";
  const counts = links.reduce((acc, link) => {
    acc[link.type] = (acc[link.type] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([type, count]) => `${count} ${type.replace("_", " ")}`)
    .join(", ");
}

function githubIssueLabel(object, url) {
  const number = object.number || url.match(/\/issues\/(\d+)/)?.[1];
  return number ? `Issue #${number}` : object.title || "Open issue";
}

function draftLabel(action) {
  if (action === "forward_draft_created") return "Forward draft";
  if (action === "reply_draft_created") return "Reply draft";
  return "New draft";
}

function gmailDraftSearchHref(subject) {
  const query = subject ? `in:drafts "${subject}"` : "in:drafts";
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function isGithubUrl(value) {
  return /^https:\/\/github\.com\//i.test(String(value || ""));
}

function isGithubIssueUrl(value) {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/i.test(String(value || ""));
}

function isEconomistUrl(value) {
  return /^https:\/\/(www\.)?economist\.com\//i.test(String(value || ""));
}

function realText(value) {
  const text = String(value || "").trim();
  return text && text !== "...";
}

function parseJson(value) {
  if (!value || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = parseJson(text);
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.message || body?.status || `Request failed (${response.status})`);
  }
  return body;
}

function timestampForToolItem(item, turn, conversation) {
  const exact = firstString(
    item?.happened_at,
    item?.created_at,
    item?.started_at,
    item?.received_at,
    item?.timestamp
  );
  if (exact) return exact;

  const unixSeconds = numberOrNull(
    item?.time_unix_secs ??
      item?.start_time_unix_secs ??
      item?.created_at_unix_secs ??
      item?.timestamp_unix_secs
  );
  if (unixSeconds != null) return new Date(unixSeconds * 1000).toISOString();

  const offsetSeconds = numberOrNull(item?.time_in_call_secs);
  if (offsetSeconds != null) return timestampFromConversationOffset(conversation, offsetSeconds);

  return timestampForTurn(turn, conversation);
}

function timestampForTurn(turn, conversation) {
  const exact = firstString(
    turn?.happened_at,
    turn?.created_at,
    turn?.started_at,
    turn?.received_at,
    turn?.timestamp
  );
  if (exact) return exact;

  const unixSeconds = numberOrNull(
    turn?.time_unix_secs ??
      turn?.start_time_unix_secs ??
      turn?.created_at_unix_secs ??
      turn?.timestamp_unix_secs
  );
  if (unixSeconds != null) return new Date(unixSeconds * 1000).toISOString();

  const offsetSeconds = numberOrNull(turn?.time_in_call_secs);
  if (offsetSeconds != null) return timestampFromConversationOffset(conversation, offsetSeconds);

  return conversation?.started_at || conversation?.updated_at || "";
}

function timestampFromConversationOffset(conversation, offsetSeconds) {
  const start = dateOrNull(conversation?.started_at || conversation?.created_at);
  if (!start) return conversation?.started_at || conversation?.updated_at || "";
  return new Date(start.getTime() + offsetSeconds * 1000).toISOString();
}

function formatDateTime(value) {
  if (!value) return "unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatLocalTime(value) {
  const date = dateOrNull(value);
  if (!date) return "local time pending";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "long",
  }).format(date);
}

function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total)) return "";
  const minutes = Math.floor(total / 60);
  const rest = Math.round(total % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function capitalize(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 720px)").matches
  );

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const query = window.matchMedia("(max-width: 720px)");
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isMobile;
}

createRoot(document.getElementById("root")).render(<App />);
