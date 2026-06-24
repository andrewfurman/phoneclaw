import fs from "node:fs";
import { htmlToText } from "html-to-text";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;
const DEFAULT_MAX_TEXT_CHARS = 30_000;
const MAX_TEXT_CHARS = 120_000;
const DEFAULT_EXCERPT_CHARS = 320;
const DEFAULT_CACHE_SECONDS = 900;
const DEFAULT_TIMEOUT_MS = 12_000;

const feedCache = new Map();

export function configuredRssFeedsConfigured() {
  return loadConfiguredFeeds().feeds.length > 0;
}

export async function rssListConfiguredFeeds() {
  const config = loadConfiguredFeeds();
  if (!config.feeds.length) return notConfiguredResponse(config.errors);

  return {
    ok: true,
    status: "ok",
    provider: "configured_rss",
    returned_count: config.feeds.length,
    configuration_errors: config.errors,
    feeds: config.feeds.map(feedMetadata),
    answer_text: `Configured ${config.feeds.length} RSS feed${config.feeds.length === 1 ? "" : "s"}.`,
  };
}

export async function rssConfiguredRecentEntries({
  feedId,
  limit = DEFAULT_LIMIT,
  maxExcerptChars = DEFAULT_EXCERPT_CHARS,
  refresh = false,
} = {}) {
  return rssConfiguredSearchEntries({
    feedId,
    query: "",
    limit,
    maxExcerptChars,
    refresh,
  });
}

export async function rssConfiguredSearchEntries({
  feedId,
  query = "",
  startDate,
  endDate,
  limit = DEFAULT_LIMIT,
  maxExcerptChars = DEFAULT_EXCERPT_CHARS,
  refresh = false,
} = {}) {
  const config = loadConfiguredFeeds();
  if (!config.feeds.length) return notConfiguredResponse(config.errors);

  const selected = selectFeeds(config.feeds, feedId);
  if (!selected.ok) return selected;

  const boundedLimit = clampInteger(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const boundedExcerptChars = clampInteger(maxExcerptChars, 80, 1_200, DEFAULT_EXCERPT_CHARS);
  const normalizedQuery = normalizeString(query).toLowerCase();
  const after = unixSeconds(startDate);
  const before = unixSeconds(endDate);

  const feedResults = await Promise.all(
    selected.feeds.map((feed) => loadFeedItems(feed, { force: toBoolean(refresh, false) }))
  );
  const items = [];
  for (const result of feedResults) {
    if (!result.ok) continue;
    for (const item of result.items) {
      const published = unixSeconds(item.published_at || item.updated_at);
      if (after && published && published < after) continue;
      if (before && published && published > before) continue;
      if (normalizedQuery && !searchableEntryText(item).toLowerCase().includes(normalizedQuery)) {
        continue;
      }
      items.push(compactFeedEntry(item, { maxExcerptChars: boundedExcerptChars }));
    }
  }

  const matchingItems = dedupeEntries(items).sort(compareEntriesByPublishedDesc);
  const sorted = matchingItems.slice(0, boundedLimit);
  const failures = feedResults.filter((result) => !result.ok);
  if (!sorted.length && failures.length === feedResults.length) {
    return {
      ok: false,
      status: "rss_feed_fetch_failed",
      provider: "configured_rss",
      query: normalizeString(query),
      feed_id: normalizeString(feedId),
      feeds: feedResults.map(feedFetchSummary),
      configuration_errors: config.errors,
      answer_text: "I could not fetch any configured RSS feeds.",
    };
  }

  return {
    ok: true,
    status: "ok",
    provider: "configured_rss",
    source: "configured_feeds",
    query: normalizeString(query),
    start_date: startDate || "",
    end_date: endDate || "",
    feed_id: normalizeString(feedId),
    limit: boundedLimit,
    max_limit: MAX_LIMIT,
    returned_count: sorted.length,
    total_count: matchingItems.length,
    available_count: matchingItems.length,
    has_more: matchingItems.length > sorted.length,
    feeds: feedResults.map(feedFetchSummary),
    configuration_errors: config.errors,
    items: sorted,
    answer_text: formatEntriesAnswer(sorted, {
      query: normalizeString(query),
      feedId: normalizeString(feedId),
    }),
  };
}

export async function rssConfiguredEntryFullText({
  entryId,
  id,
  articleUrl,
  url,
  feedId,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  refresh = false,
} = {}) {
  const config = loadConfiguredFeeds();
  if (!config.feeds.length) return notConfiguredResponse(config.errors);

  const normalizedEntryId = normalizeString(entryId || id);
  const normalizedUrl = normalizeString(articleUrl || url);
  if (!normalizedEntryId && !normalizedUrl) {
    return missingField("entry_id", "A configured RSS entry id or article URL is required.");
  }

  const selected = selectFeeds(config.feeds, feedId);
  if (!selected.ok) return selected;

  const boundedMax = clampInteger(maxTextChars, 2_000, MAX_TEXT_CHARS, DEFAULT_MAX_TEXT_CHARS);
  let feedResults = await Promise.all(
    selected.feeds.map((feed) => loadFeedItems(feed, { force: toBoolean(refresh, false) }))
  );
  let match = findEntry(feedResults, { entryId: normalizedEntryId, articleUrl: normalizedUrl });

  if (!match && !toBoolean(refresh, false)) {
    feedResults = await Promise.all(selected.feeds.map((feed) => loadFeedItems(feed, { force: true })));
    match = findEntry(feedResults, { entryId: normalizedEntryId, articleUrl: normalizedUrl });
  }

  if (!match) {
    return {
      ok: false,
      status: "rss_entry_not_found",
      provider: "configured_rss",
      entry_id: normalizedEntryId,
      article_url: normalizedUrl,
      feed_id: normalizeString(feedId),
      feeds: feedResults.map(feedFetchSummary),
      answer_text: "I could not find that article in the configured RSS feeds.",
    };
  }

  const text = normalizeArticleText(match.entry.full_text || match.entry.summary || "");
  const truncated = truncateText(text, boundedMax);
  const fullArticleAvailable = text.length >= 700 && match.entry.content_source !== "feed_summary";
  const accessNote =
    fullArticleAvailable || text.length >= 700
      ? ""
      : "The returned article text is short; this feed may only provide an excerpt.";

  return {
    ok: true,
    status: "ok",
    provider: "configured_rss",
    source: match.entry.feed_id,
    entry: compactFeedEntry(match.entry, { maxExcerptChars: 420 }),
    entry_id: match.entry.id,
    feed_id: match.entry.feed_id,
    feed_title: match.entry.feed_title,
    content_source: match.entry.content_source,
    full_article_available: fullArticleAvailable,
    full_text_chars: text.length,
    returned_text_chars: truncated.value.length,
    full_text_truncated: truncated.truncated,
    access_note: accessNote,
    full_text: truncated.value,
    answer_text: articleAnswerText({
      title: match.entry.title,
      fullArticleAvailable,
      truncated: truncated.truncated,
      feedTitle: match.entry.feed_title,
    }),
  };
}

export async function rssRefreshConfiguredFeeds({ feedId } = {}) {
  const config = loadConfiguredFeeds();
  if (!config.feeds.length) return notConfiguredResponse(config.errors);

  const selected = selectFeeds(config.feeds, feedId);
  if (!selected.ok) return selected;

  const feedResults = await Promise.all(
    selected.feeds.map((feed) => loadFeedItems(feed, { force: true }))
  );
  const okCount = feedResults.filter((result) => result.ok).length;

  return {
    ok: okCount > 0,
    status: okCount > 0 ? "ok" : "rss_feed_fetch_failed",
    provider: "configured_rss",
    refreshed_count: okCount,
    returned_count: okCount,
    feeds: feedResults.map(feedFetchSummary),
    answer_text:
      okCount > 0
        ? `Refreshed ${okCount} configured RSS feed${okCount === 1 ? "" : "s"}.`
        : "I could not refresh any configured RSS feeds.",
  };
}

function loadConfiguredFeeds() {
  const errors = [];
  const rawConfigs = [];
  const path = normalizeString(process.env.RSS_FEEDS_CONFIG_PATH);
  if (path) {
    try {
      rawConfigs.push(...extractFeedArray(JSON.parse(fs.readFileSync(path, "utf8"))));
    } catch (error) {
      errors.push(`Could not read RSS_FEEDS_CONFIG_PATH: ${error?.message || String(error)}`);
    }
  }

  const json = normalizeString(process.env.RSS_FEEDS_JSON);
  if (json) {
    try {
      rawConfigs.push(...extractFeedArray(JSON.parse(json)));
    } catch (error) {
      errors.push(`Could not parse RSS_FEEDS_JSON: ${error?.message || String(error)}`);
    }
  }

  const feeds = [];
  const seen = new Set();
  for (const raw of rawConfigs) {
    const feed = normalizeFeedConfig(raw, errors);
    if (!feed) continue;
    if (seen.has(feed.id)) {
      errors.push(`Duplicate RSS feed id ignored: ${feed.id}`);
      continue;
    }
    seen.add(feed.id);
    feeds.push(feed);
  }

  return { feeds, errors };
}

function extractFeedArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.feeds)) return value.feeds;
  return [];
}

function normalizeFeedConfig(raw, errors) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.enabled === false || raw.disabled === true) return null;

  const url = normalizeString(raw.url || raw.feed_url || raw.feedUrl);
  if (!url) {
    errors.push("Skipped RSS feed config with no url.");
    return null;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    errors.push(`Skipped RSS feed config with invalid url: ${url.slice(0, 120)}`);
    return null;
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    errors.push(`Skipped RSS feed config with unsupported protocol: ${parsedUrl.protocol}`);
    return null;
  }

  const title = normalizeString(raw.title || raw.name, parsedUrl.hostname);
  const id = normalizeFeedId(raw.id || raw.feed_id || title || parsedUrl.hostname || url);
  if (!id) {
    errors.push(`Skipped RSS feed config with invalid id for ${parsedUrl.hostname}.`);
    return null;
  }

  return {
    id,
    title,
    url,
    private: toBoolean(raw.private, false),
    headers: raw.headers && typeof raw.headers === "object" ? raw.headers : {},
    cache_seconds: clampInteger(
      raw.cache_seconds || raw.cacheSeconds || process.env.RSS_FEEDS_CACHE_SECONDS,
      0,
      86_400,
      DEFAULT_CACHE_SECONDS
    ),
    timeout_ms: clampInteger(
      raw.timeout_ms || raw.timeoutMs || process.env.RSS_FEEDS_TIMEOUT_MS,
      2_000,
      60_000,
      DEFAULT_TIMEOUT_MS
    ),
  };
}

function selectFeeds(feeds, feedId) {
  const normalizedId = normalizeFeedId(feedId);
  if (!normalizedId) return { ok: true, feeds };

  const feed = feeds.find((item) => item.id === normalizedId);
  if (!feed) {
    return {
      ok: false,
      status: "rss_feed_not_found",
      provider: "configured_rss",
      feed_id: normalizedId,
      feeds: feeds.map(feedMetadata),
      answer_text: `I could not find a configured RSS feed named ${normalizedId}.`,
    };
  }

  return { ok: true, feeds: [feed] };
}

async function loadFeedItems(feed, { force = false } = {}) {
  const cached = feedCache.get(feed.id);
  const cacheFresh =
    cached?.ok &&
    feed.cache_seconds > 0 &&
    Date.now() - cached.fetched_at_ms < feed.cache_seconds * 1000;
  if (!force && cacheFresh) {
    return { ...cached, cache_status: "hit", feed };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), feed.timeout_ms);
  try {
    const response = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
        "user-agent": "phoneclaw-configured-rss/1.0",
        ...feed.headers,
      },
    });
    const xml = await response.text();
    if (!response.ok) {
      return feedFetchError({
        feed,
        status: "rss_feed_request_failed",
        upstreamStatus: response.status,
        message: xml.slice(0, 500) || "RSS feed request failed.",
        cached,
      });
    }

    const parsed = parseFeedEntries(xml, feed);
    const result = {
      ok: true,
      status: "ok",
      cache_status: "refreshed",
      feed,
      fetched_at_ms: Date.now(),
      fetched_at: new Date().toISOString(),
      item_count: parsed.items.length,
      feed_title: parsed.feed_title || feed.title,
      feed_url: redactedFeedUrl(feed),
      items: parsed.items,
    };
    feedCache.set(feed.id, result);
    return result;
  } catch (error) {
    return feedFetchError({
      feed,
      status: error?.name === "AbortError" ? "rss_feed_timeout" : "rss_feed_request_failed",
      message: error?.message || "RSS feed request failed.",
      cached,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function feedFetchError({ feed, status, message, upstreamStatus, cached }) {
  if (cached?.ok) {
    return {
      ...cached,
      cache_status: "stale",
      stale_reason: status,
      stale_message: message,
      feed,
    };
  }

  return {
    ok: false,
    status,
    upstream_status: upstreamStatus || null,
    message,
    feed,
    feed_id: feed.id,
    feed_title: feed.title,
    feed_url: redactedFeedUrl(feed),
    items: [],
  };
}

function parseFeedEntries(xml, feed) {
  const text = String(xml || "");
  const feedTitle = tagText(text, "title") || feed.title;
  const rssItems = xmlBlocks(text, "item");
  if (rssItems.length) {
    return {
      feed_title: feedTitle,
      items: rssItems.map((block) => rssItemEntry(block, feed, feedTitle)),
    };
  }

  const atomEntries = xmlBlocks(text, "entry");
  return {
    feed_title: feedTitle,
    items: atomEntries.map((block) => atomEntry(block, feed, feedTitle)),
  };
}

function rssItemEntry(block, feed, feedTitle) {
  const title = tagText(block, "title");
  const link = tagText(block, "link") || tagText(block, "guid");
  const contentHtml = tagText(block, "content:encoded") || tagText(block, "encoded");
  const descriptionHtml = tagText(block, "description") || tagText(block, "summary");
  const html = contentHtml || descriptionHtml;
  const fullText = normalizeArticleText(htmlToReadableText(html));
  const url = normalizeString(link);
  const publishedAt = normalizeDate(tagText(block, "pubDate") || tagText(block, "published"));
  const updatedAt = normalizeDate(tagText(block, "updated") || tagText(block, "dc:date"));

  return {
    id: entryId(feed.id, url || tagText(block, "guid") || title),
    feed_id: feed.id,
    feed_title: feedTitle || feed.title,
    feed_url: redactedFeedUrl(feed),
    title,
    url,
    author: tagText(block, "author") || tagText(block, "dc:creator"),
    published_at: publishedAt,
    updated_at: updatedAt,
    created_at: "",
    changed_at: updatedAt,
    source: tagText(block, "source") || feed.title,
    content_source: contentHtml ? "feed_content_encoded" : "feed_summary",
    full_text: fullText,
    summary: normalizeArticleText(htmlToReadableText(descriptionHtml || contentHtml)),
    full_text_available: contentHtml ? fullText.length >= 700 : false,
    reading_time: readingTime(fullText),
  };
}

function atomEntry(block, feed, feedTitle) {
  const title = tagText(block, "title");
  const url = atomLink(block) || tagText(block, "id");
  const contentHtml = tagText(block, "content");
  const summaryHtml = tagText(block, "summary");
  const html = contentHtml || summaryHtml;
  const fullText = normalizeArticleText(htmlToReadableText(html));
  const publishedAt = normalizeDate(tagText(block, "published"));
  const updatedAt = normalizeDate(tagText(block, "updated"));

  return {
    id: entryId(feed.id, url || tagText(block, "id") || title),
    feed_id: feed.id,
    feed_title: feedTitle || feed.title,
    feed_url: redactedFeedUrl(feed),
    title,
    url,
    author: nestedTagText(block, "author", "name"),
    published_at: publishedAt || updatedAt,
    updated_at: updatedAt,
    created_at: "",
    changed_at: updatedAt,
    source: feed.title,
    content_source: contentHtml ? "feed_content" : "feed_summary",
    full_text: fullText,
    summary: normalizeArticleText(htmlToReadableText(summaryHtml || contentHtml)),
    full_text_available: contentHtml ? fullText.length >= 700 : false,
    reading_time: readingTime(fullText),
  };
}

function xmlBlocks(xml, tagName) {
  const escaped = escapeRegExp(tagName);
  return [...String(xml || "").matchAll(new RegExp(`<${escaped}\\b[\\s\\S]*?<\\/${escaped}>`, "gi"))].map(
    (match) => match[0]
  );
}

function tagText(block, tagName) {
  const escaped = escapeRegExp(tagName);
  const match = String(block || "").match(
    new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i")
  );
  if (!match) return "";
  return decodeXmlEntities(stripCdata(match[1])).trim();
}

function nestedTagText(block, outerTagName, innerTagName) {
  const outer = tagTextBlock(block, outerTagName);
  return outer ? tagText(outer, innerTagName) : "";
}

function tagTextBlock(block, tagName) {
  const escaped = escapeRegExp(tagName);
  const match = String(block || "").match(
    new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i")
  );
  return match ? match[0] : "";
}

function atomLink(block) {
  const links = [...String(block || "").matchAll(/<link\b([^>]*)>/gi)];
  const alternate =
    links.find((match) => /rel=["']alternate["']/i.test(match[1])) || links[0];
  if (!alternate) return "";
  const href = alternate[1].match(/\bhref=["']([^"']+)["']/i);
  return href ? decodeXmlEntities(href[1]).trim() : "";
}

function htmlToReadableText(value) {
  return htmlToText(String(value || ""), {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  });
}

function findEntry(feedResults, { entryId: requestedId, articleUrl }) {
  const normalizedId = normalizeString(requestedId);
  const normalizedUrl = canonicalArticleUrl(articleUrl);
  for (const feedResult of feedResults) {
    if (!feedResult.ok) continue;
    for (const entry of feedResult.items) {
      if (normalizedId && entry.id === normalizedId) return { feedResult, entry };
      if (normalizedUrl && canonicalArticleUrl(entry.url) === normalizedUrl) {
        return { feedResult, entry };
      }
    }
  }
  return null;
}

function compactFeedEntry(entry, { maxExcerptChars }) {
  const text = normalizeArticleText(entry.summary || entry.full_text || "");
  return {
    id: entry.id,
    title: entry.title || "",
    url: entry.url || "",
    author: entry.author || "",
    published_at: entry.published_at || "",
    created_at: entry.created_at || "",
    changed_at: entry.changed_at || entry.updated_at || "",
    status: "",
    starred: false,
    reading_time: entry.reading_time ?? readingTime(entry.full_text),
    feed_id: entry.feed_id,
    feed_title: entry.feed_title || "",
    feed_url: entry.feed_url || "",
    category_title: "",
    source: entry.source || entry.feed_title || "",
    content_source: entry.content_source || "",
    full_text_available: Boolean(entry.full_text_available),
    excerpt: truncateText(text, maxExcerptChars).value,
  };
}

function feedMetadata(feed) {
  return {
    id: feed.id,
    title: feed.title,
    private: feed.private,
    cache_seconds: feed.cache_seconds,
    feed_url: redactedFeedUrl(feed),
  };
}

function feedFetchSummary(result) {
  const feed = result.feed || {};
  return {
    id: feed.id || result.feed_id || "",
    title: feed.title || result.feed_title || "",
    ok: Boolean(result.ok),
    status: result.status || "",
    cache_status: result.cache_status || "",
    fetched_at: result.fetched_at || "",
    item_count: result.item_count || result.items?.length || 0,
    stale_reason: result.stale_reason || "",
    feed_url: result.feed_url || redactedFeedUrl(feed),
  };
}

function searchableEntryText(entry) {
  return [
    entry.title,
    entry.url,
    entry.author,
    entry.feed_title,
    entry.source,
    entry.summary,
    entry.full_text,
  ].join(" ");
}

function dedupeEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = canonicalArticleUrl(entry.url) || entry.id || normalizeString(entry.title).toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(entry);
  }
  return result;
}

function compareEntriesByPublishedDesc(left, right) {
  return unixSeconds(right.published_at || right.changed_at) - unixSeconds(left.published_at || left.changed_at);
}

function formatEntriesAnswer(entries, { query, feedId }) {
  const scope = feedId ? ` from ${feedId}` : "";
  if (!entries.length) {
    return query
      ? `No configured RSS entries matched "${query}"${scope}.`
      : `No recent configured RSS entries were found${scope}.`;
  }

  const heading = query
    ? `Found ${entries.length} configured RSS entr${entries.length === 1 ? "y" : "ies"} matching "${query}"${scope}.`
    : `Returned ${entries.length} recent configured RSS entr${entries.length === 1 ? "y" : "ies"}${scope}.`;
  const lines = entries.slice(0, 5).map((entry, index) => {
    const feed = entry.feed_title ? ` from ${entry.feed_title}` : "";
    const date = entry.published_at ? `, published ${entry.published_at.slice(0, 10)}` : "";
    return `${index + 1}. ${entry.title}${feed}${date}. Entry id ${entry.id}.`;
  });
  return [heading, ...lines].join("\n");
}

function articleAnswerText({ title, fullArticleAvailable, truncated, feedTitle }) {
  const name = title || "the article";
  const completeness = fullArticleAvailable
    ? "The feed entry includes full article text."
    : "The feed entry may only include an excerpt.";
  const limit = truncated ? " The returned text is truncated by the configured character limit." : "";
  return `Retrieved "${name}"${feedTitle ? ` from ${feedTitle}` : ""}. ${completeness}${limit}`;
}

function entryId(feedId, value) {
  return `${feedId}:${hashString(canonicalArticleUrl(value) || normalizeString(value).toLowerCase()).toString(36)}`;
}

function normalizeFeedId(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeDate(value) {
  const raw = normalizeString(value);
  if (!raw) return "";
  const millis = Date.parse(raw);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : raw;
}

function unixSeconds(value) {
  const raw = normalizeString(value);
  if (!raw) return 0;
  const millis = Date.parse(raw);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : 0;
}

function readingTime(value) {
  const words = normalizeArticleText(value).split(/\s+/).filter(Boolean).length;
  return words ? Math.max(1, Math.round(words / 225)) : null;
}

function redactedFeedUrl(feed) {
  if (!feed?.url) return "";
  try {
    const url = new URL(feed.url);
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of [...url.searchParams.keys()]) {
      if (feed.private || /token|secret|key|password|signature|auth|session/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return String(feed.url).replace(
      /([?&][^=]*(?:token|secret|key|password|signature|auth|session)[^=]*=)[^&\s]*/gi,
      "$1[redacted]"
    );
  }
}

function canonicalArticleUrl(value) {
  const raw = normalizeString(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function stripCdata(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "");
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function normalizeArticleText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function truncateText(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return { value: text, truncated: false };
  return {
    value: text.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}

function notConfiguredResponse(errors = []) {
  return {
    ok: false,
    status: "rss_feeds_not_configured",
    provider: "configured_rss",
    message: "No configured RSS feeds were found. Set RSS_FEEDS_JSON or RSS_FEEDS_CONFIG_PATH.",
    configuration_errors: errors,
    answer_text: "No RSS feeds are configured on the bridge yet.",
  };
}

function missingField(field, message) {
  return {
    ok: false,
    status: "missing_field",
    field,
    message,
    answer_text: message,
  };
}

function normalizeString(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function toBoolean(value, fallback = false) {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return fallback;
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
