const DUCKDUCKGO_PROVIDER = "DuckDuckGo";
const TAVILY_PROVIDER = "Tavily";

export async function basicWebSearch({
  query,
  maxResults = 5,
  provider,
  tavilyApiKey,
  tavilySearchDepth,
  fetchImpl = fetch,
}) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    return {
      ok: false,
      status: "missing_query",
      message: "A search query is required.",
      results: [],
    };
  }

  const limit = clampInteger(maxResults, 1, 8);
  const now = new Date();
  const searchedQuery = addRelativeDateContext(cleanQuery, now);

  if (shouldUseTavily({ provider, tavilyApiKey })) {
    const tavily = await fetchTavilySearch({
      query: searchedQuery,
      maxResults: limit,
      tavilyApiKey,
      tavilySearchDepth,
      fetchImpl,
    }).catch((error) => ({
      ok: false,
      status: "tavily_failed",
      message: error?.message || "Tavily search failed.",
    }));
    if (tavily.ok) {
      const sports = await fetchSportsEnrichment(cleanQuery, now, fetchImpl).catch(() => null);
      return {
        ok: true,
        query: cleanQuery,
        searched_query: searchedQuery,
        provider: TAVILY_PROVIDER,
        as_of: now.toISOString(),
        source_note:
          "Web search uses Tavily when selected and configured, with DuckDuckGo available as the no-key fallback.",
        result_count: tavily.results.length,
        sports_events: sports?.events || [],
        answer_text: formatAnswerText(cleanQuery, searchedQuery, tavily.results, sports),
        results: tavily.results.slice(0, limit),
      };
    }
  }

  const [instantAnswer, htmlResults, sportsEnrichment] = await Promise.allSettled([
    fetchDuckDuckGoInstantAnswer(searchedQuery, fetchImpl),
    fetchDuckDuckGoHtmlResults(searchedQuery, limit, fetchImpl),
    fetchSportsEnrichment(cleanQuery, now, fetchImpl),
  ]);

  const results = [];
  const instant = instantAnswer.status === "fulfilled" ? instantAnswer.value : null;
  const html = htmlResults.status === "fulfilled" ? htmlResults.value : [];
  const sports =
    sportsEnrichment.status === "fulfilled" ? sportsEnrichment.value : null;

  if (instant?.answer) {
    results.push({
      title: instant.heading || "Instant answer",
      url: instant.url || "",
      snippet: instant.answer,
    });
  }

  for (const result of [...(instant?.results || []), ...html]) {
    if (result.url && results.some((existing) => existing.url === result.url)) continue;
    results.push(result);
    if (results.length >= limit) break;
  }

  return {
    ok: true,
    query: cleanQuery,
    searched_query: searchedQuery,
    provider: DUCKDUCKGO_PROVIDER,
    as_of: now.toISOString(),
    source_note:
      "Basic web search uses DuckDuckGo public endpoints and may be incomplete for live sports schedules or fast-moving news.",
    result_count: results.length,
    sports_events: sports?.events || [],
    answer_text: formatAnswerText(cleanQuery, searchedQuery, results, sports),
    results: results.slice(0, limit),
  };
}

function shouldUseTavily({ provider, tavilyApiKey }) {
  const configuredKey =
    tavilyApiKey ||
    (typeof process === "undefined" ? "" : process.env.TAVILY_API_KEY);
  const configuredProvider =
    provider ||
    (typeof process === "undefined" ? "" : process.env.WEB_SEARCH_PROVIDER) ||
    (configuredKey ? "auto" : "");
  const normalizedProvider = String(configuredProvider || "").toLowerCase();
  return Boolean(configuredKey) && ["tavily", "auto"].includes(normalizedProvider);
}

async function fetchTavilySearch({
  query,
  maxResults,
  tavilyApiKey,
  tavilySearchDepth,
  fetchImpl,
}) {
  const apiKey =
    tavilyApiKey ||
    (typeof process === "undefined" ? "" : process.env.TAVILY_API_KEY);
  if (!apiKey) {
    return {
      ok: false,
      status: "tavily_not_configured",
      message: "TAVILY_API_KEY is not configured.",
    };
  }

  const response = await fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "user-agent": "phoneclaw/0.1 web-search",
    },
    body: JSON.stringify({
      query,
      search_depth:
        tavilySearchDepth ||
        (typeof process === "undefined" ? "" : process.env.TAVILY_SEARCH_DEPTH) ||
        "basic",
      max_results: maxResults,
      include_answer: true,
      include_raw_content: false,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      status: "tavily_search_failed",
      tavily_status: response.status,
      message: body.error || body.message || "Tavily search failed.",
      results: [],
    };
  }

  const results = (body.results || [])
    .map((result) => ({
      title: result.title || result.url || "Search result",
      url: result.url || "",
      snippet: result.content || result.snippet || "",
      source: TAVILY_PROVIDER,
      score: result.score ?? null,
    }))
    .filter((result) => result.url || result.snippet);

  if (body.answer) {
    results.unshift({
      title: "Tavily answer",
      url: "",
      snippet: body.answer,
      source: TAVILY_PROVIDER,
      score: null,
    });
  }

  return {
    ok: true,
    provider: TAVILY_PROVIDER,
    results: results.slice(0, maxResults),
  };
}

function addRelativeDateContext(query, now) {
  if (!/\b(today|tonight|tomorrow|yesterday)\b/i.test(query)) return query;
  if (/\b20\d{2}\b/.test(query)) return query;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return `${query} ${formatter.format(now)}`;
}

async function fetchSportsEnrichment(query, now, fetchImpl) {
  if (!isFifaWorldCupQuery(query)) return null;

  const date = resolveQueryDate(query, now);
  const url = new URL(
    "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard"
  );
  url.searchParams.set("dates", date.espnDate);
  url.searchParams.set("limit", "100");

  const response = await fetchImpl(url.toString(), {
    headers: {
      accept: "application/json",
      "user-agent": "phoneclaw/0.1 basic-web-search",
    },
  });

  if (!response.ok) return null;

  const body = await response.json();
  const events = (body.events || []).map(parseEspnSoccerEvent).filter(Boolean);
  if (events.length === 0) return null;

  return {
    provider: "ESPN public scoreboard",
    league: "FIFA World Cup",
    date: date.isoDate,
    date_label: date.label,
    events,
  };
}

function isFifaWorldCupQuery(query) {
  const value = String(query || "").toLowerCase();
  if (!value.includes("world cup")) return false;
  if (/\b(cricket|rugby|club world cup|club world)\b/.test(value)) return false;
  return /\b(fifa|soccer|football|match|matches|game|games|schedule|score|today|tonight)\b/.test(
    value
  );
}

function resolveQueryDate(query, now) {
  const value = String(query || "").toLowerCase();
  const dayOffset = value.includes("tomorrow")
    ? 1
    : value.includes("yesterday")
      ? -1
      : 0;
  const target = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  const timeZone = "America/New_York";

  return {
    espnDate: formatDateParts(target, timeZone, ""),
    isoDate: formatDateParts(target, timeZone, "-"),
    label: new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(target),
  };
}

function parseEspnSoccerEvent(event) {
  const competition = event.competitions?.[0];
  if (!competition) return null;

  const competitors = competition.competitors || [];
  const home = competitors.find((competitor) => competitor.homeAway === "home");
  const away = competitors.find((competitor) => competitor.homeAway === "away");
  if (!home || !away) return null;

  const status = event.status?.type?.description || "";
  const isScheduled = event.status?.type?.state === "pre";
  const score = isScheduled ? "" : `${away.score}-${home.score}`;

  return {
    name: event.name || `${away.team?.displayName} at ${home.team?.displayName}`,
    short_name: event.shortName || "",
    start_time_utc: event.date,
    start_time_eastern: formatEasternTime(event.date),
    status,
    venue: competition.venue?.fullName || "",
    home_team: home.team?.displayName || "",
    away_team: away.team?.displayName || "",
    score,
  };
}

function formatDateParts(date, timeZone, separator) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value || "";
  return [part("year"), part("month"), part("day")].join(separator);
}

function formatEasternTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function formatAnswerText(originalQuery, searchedQuery, results, sports) {
  const sections = [];

  if (sports?.events?.length > 0) {
    sections.push(
      [
        `${sports.league} schedule from ${sports.provider} for ${sports.date_label}:`,
        ...sports.events.map((event, index) => {
          const score = event.score ? `, score ${event.score}` : "";
          const venue = event.venue ? ` at ${event.venue}` : "";
          return `${index + 1}. ${event.away_team} at ${event.home_team}, ${event.start_time_eastern}, ${event.status}${score}${venue}`;
        }),
      ].join("\n")
    );
  }

  if (results.length > 0) {
    const heading =
      originalQuery === searchedQuery
        ? `Web results for "${originalQuery}":`
        : `Web results for "${originalQuery}" searched as "${searchedQuery}":`;

    sections.push([
      heading,
      ...results.slice(0, 5).map((result, index) =>
        [
          `${index + 1}. ${result.title}`,
          result.snippet ? `Snippet: ${result.snippet}` : "",
          result.url ? `URL: ${result.url}` : "",
        ]
          .filter(Boolean)
          .join(" | ")
      ),
    ].join("\n"));
  }

  if (sections.length === 0) {
    return `No web results found for "${searchedQuery}".`;
  }

  return sections.join("\n\n");
}

async function fetchDuckDuckGoInstantAnswer(query, fetchImpl) {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("no_redirect", "1");
  url.searchParams.set("skip_disambig", "1");

  const response = await fetchImpl(url.toString(), {
    headers: {
      accept: "application/json",
      "user-agent": "phoneclaw/0.1 basic-web-search",
    },
  });

  if (!response.ok) return null;

  const body = await response.json();
  const related = flattenRelatedTopics(body.RelatedTopics || [])
    .map((topic) => ({
      title: topic.Text?.split(" - ")[0] || topic.FirstURL || "Search result",
      url: topic.FirstURL || "",
      snippet: topic.Text || "",
    }))
    .filter((result) => result.url || result.snippet);

  return {
    heading: body.Heading || "",
    answer: body.AbstractText || body.Answer || "",
    url: body.AbstractURL || "",
    results: related,
  };
}

async function fetchDuckDuckGoHtmlResults(query, maxResults, fetchImpl) {
  const response = await fetchImpl("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "phoneclaw/0.1 basic-web-search",
    },
    body: new URLSearchParams({ q: query }).toString(),
  });

  if (!response.ok) return [];

  const html = await response.text();
  const blocks = html.split(/<div class="result results_links[^>]*>/i).slice(1);

  return blocks
    .map(parseDuckDuckGoResultBlock)
    .filter((result) => result.title && result.url && !isLikelyAdUrl(result.url))
    .slice(0, maxResults);
}

function parseDuckDuckGoResultBlock(block) {
  const linkMatch = block.match(
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
  );
  const snippetMatch = block.match(
    /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i
  );
  const rawUrl = linkMatch?.[1] || "";

  return {
    title: cleanHtml(linkMatch?.[2] || ""),
    url: normalizeDuckDuckGoUrl(decodeHtml(rawUrl)),
    snippet: cleanHtml(snippetMatch?.[1] || ""),
  };
}

function flattenRelatedTopics(topics) {
  return topics.flatMap((topic) => {
    if (Array.isArray(topic.Topics)) return flattenRelatedTopics(topic.Topics);
    return [topic];
  });
}

function normalizeDuckDuckGoUrl(value) {
  try {
    const url = new URL(value, "https://duckduckgo.com");
    const unwrapped = url.searchParams.get("uddg");
    return unwrapped || url.toString();
  } catch {
    return value;
  }
}

function isLikelyAdUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.hostname === "duckduckgo.com" &&
      (url.pathname === "/y.js" || url.searchParams.has("ad_provider"))
    ) || url.hostname.endsWith("bing.com") && url.pathname.includes("/aclick");
  } catch {
    return false;
  }
}

function cleanHtml(value) {
  return decodeHtml(String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function clampInteger(value, min, max) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}
