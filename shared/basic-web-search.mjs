const DUCKDUCKGO_PROVIDER = "DuckDuckGo";
const TAVILY_PROVIDER = "Tavily";
const WIKIPEDIA_PROVIDER = "Wikipedia";
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

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
  const diagnostics = [];

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
      results: [],
    }));
    diagnostics.push(providerDiagnostic(TAVILY_PROVIDER, tavily));
    if (tavily.ok && tavily.results.length > 0) {
      const { sports, marketData, marketHistory } = await fetchEnrichments(
        cleanQuery,
        now,
        fetchImpl
      );
      return searchResponse({
        cleanQuery,
        searchedQuery,
        provider: TAVILY_PROVIDER,
        sourceNote:
          "Web search uses Tavily when selected and configured, with DuckDuckGo and Wikipedia fallbacks for empty or failed provider responses.",
        results: tavily.results,
        sports,
        marketData,
        marketHistory,
        now,
        limit,
        diagnostics,
      });
    }
  }

  const [
    instantAnswer,
    htmlResults,
    sportsEnrichment,
    marketEnrichment,
    marketHistoryEnrichment,
  ] = await Promise.allSettled([
    fetchDuckDuckGoInstantAnswer(searchedQuery, fetchImpl),
    fetchDuckDuckGoHtmlResults(searchedQuery, limit, fetchImpl),
    fetchSportsEnrichment(cleanQuery, now, fetchImpl),
    fetchMarketEnrichment(cleanQuery, now, fetchImpl),
    fetchMarketHistoryEnrichment(cleanQuery, now, fetchImpl),
  ]);

  const results = [];
  const instant = instantAnswer.status === "fulfilled" ? instantAnswer.value : null;
  const html = htmlResults.status === "fulfilled" ? htmlResults.value : [];
  const sports =
    sportsEnrichment.status === "fulfilled" ? sportsEnrichment.value : null;
  const marketData =
    marketEnrichment.status === "fulfilled" ? marketEnrichment.value : null;
  const marketHistory =
    marketHistoryEnrichment.status === "fulfilled" ? marketHistoryEnrichment.value : null;

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
  diagnostics.push(
    providerDiagnostic(DUCKDUCKGO_PROVIDER, {
      ok: instantAnswer.status === "fulfilled" || htmlResults.status === "fulfilled",
      status:
        instantAnswer.status === "rejected" && htmlResults.status === "rejected"
          ? "duckduckgo_failed"
          : "ok",
      result_count: results.length,
      message: [
        instantAnswer.status === "rejected" ? instantAnswer.reason?.message : "",
        htmlResults.status === "rejected" ? htmlResults.reason?.message : "",
      ]
        .filter(Boolean)
        .join("; "),
    })
  );

  if (
    results.length === 0 &&
    !sports?.events?.length &&
    !marketData &&
    !marketHistory
  ) {
    const wikipedia = await fetchWikipediaSearch({
      query: searchedQuery,
      maxResults: limit,
      fetchImpl,
    }).catch((error) => ({
      ok: false,
      status: "wikipedia_failed",
      message: error?.message || "Wikipedia fallback search failed.",
      results: [],
    }));
    diagnostics.push(providerDiagnostic(WIKIPEDIA_PROVIDER, wikipedia));

    if (wikipedia.ok && wikipedia.results.length > 0) {
      return searchResponse({
        cleanQuery,
        searchedQuery,
        provider: WIKIPEDIA_PROVIDER,
        sourceNote:
          "Primary web search returned no useful results, so this response uses Wikipedia as a factual no-key fallback.",
        results: wikipedia.results,
        sports,
        marketData,
        marketHistory,
        now,
        limit,
        diagnostics,
      });
    }
  }

  return searchResponse({
    cleanQuery,
    searchedQuery,
    provider: DUCKDUCKGO_PROVIDER,
    sourceNote:
      "Basic web search uses DuckDuckGo public endpoints and may be incomplete for live sports schedules or fast-moving news. Wikipedia is attempted when DuckDuckGo returns no useful results.",
    results,
    sports,
    marketData,
    marketHistory,
    now,
    limit,
    diagnostics,
  });
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

async function fetchEnrichments(query, now, fetchImpl) {
  const [sports, marketData, marketHistory] = await Promise.all([
    fetchSportsEnrichment(query, now, fetchImpl).catch(() => null),
    fetchMarketEnrichment(query, now, fetchImpl).catch(() => null),
    fetchMarketHistoryEnrichment(query, now, fetchImpl).catch(() => null),
  ]);

  return { sports, marketData, marketHistory };
}

function searchResponse({
  cleanQuery,
  searchedQuery,
  provider,
  sourceNote,
  results,
  sports,
  marketData,
  marketHistory,
  now,
  limit,
  diagnostics,
}) {
  const cappedResults = results.slice(0, limit);

  return {
    ok: true,
    query: cleanQuery,
    searched_query: searchedQuery,
    provider,
    as_of: now.toISOString(),
    source_note: sourceNote,
    result_count: cappedResults.length,
    sports_events: sports?.events || [],
    market_data: marketData,
    market_history: marketHistory,
    diagnostics: diagnostics.map((item) => ({
      provider: item.provider,
      ok: item.ok,
      status: item.status,
      result_count: item.result_count,
      message: item.message,
    })),
    answer_text: formatAnswerText(
      cleanQuery,
      searchedQuery,
      cappedResults,
      sports,
      marketData,
      marketHistory
    ),
    results: cappedResults,
  };
}

function providerDiagnostic(provider, result) {
  const results = Array.isArray(result?.results) ? result.results : [];
  return {
    provider,
    ok: Boolean(result?.ok),
    status: result?.status || (result?.ok ? "ok" : "failed"),
    result_count: Number.isFinite(Number(result?.result_count))
      ? Number(result.result_count)
      : results.length,
    message: normalizeWhitespace(result?.message || "").slice(0, 240),
  };
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

  const response = await fetchWithRetry(
    fetchImpl,
    "https://api.tavily.com/search",
    {
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
          "fast",
        max_results: maxResults,
        include_answer: "basic",
        include_raw_content: false,
      }),
    },
    { attempts: 2 }
  );

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
    result_count: Math.min(results.length, maxResults),
    results: results.slice(0, maxResults),
  };
}

async function fetchWikipediaSearch({ query, maxResults, fetchImpl }) {
  const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
  searchUrl.searchParams.set("action", "query");
  searchUrl.searchParams.set("list", "search");
  searchUrl.searchParams.set("srsearch", query);
  searchUrl.searchParams.set("srlimit", String(maxResults));
  searchUrl.searchParams.set("srprop", "snippet|titlesnippet");
  searchUrl.searchParams.set("format", "json");
  searchUrl.searchParams.set("origin", "*");

  const searchResponse = await fetchWithRetry(
    fetchImpl,
    searchUrl.toString(),
    {
      headers: {
        accept: "application/json",
        "user-agent": "phoneclaw/0.1 wikipedia-fallback",
      },
    },
    { attempts: 2 }
  );
  const searchBody = await searchResponse.json().catch(() => ({}));
  if (!searchResponse.ok) {
    return {
      ok: false,
      status: "wikipedia_search_failed",
      wikipedia_status: searchResponse.status,
      message:
        searchBody.error?.info ||
        searchBody.message ||
        "Wikipedia search fallback failed.",
      results: [],
    };
  }

  const searchRows = Array.isArray(searchBody.query?.search)
    ? searchBody.query.search.slice(0, maxResults)
    : [];
  if (searchRows.length === 0) {
    return {
      ok: true,
      status: "ok",
      result_count: 0,
      results: [],
    };
  }

  const pageIds = searchRows.map((row) => row.pageid).filter(Boolean);
  const snippetByPageId = new Map(
    searchRows.map((row) => [String(row.pageid), cleanHtml(row.snippet || "")])
  );

  const detailUrl = new URL("https://en.wikipedia.org/w/api.php");
  detailUrl.searchParams.set("action", "query");
  detailUrl.searchParams.set("prop", "extracts|info");
  detailUrl.searchParams.set("exintro", "1");
  detailUrl.searchParams.set("explaintext", "1");
  detailUrl.searchParams.set("inprop", "url");
  detailUrl.searchParams.set("pageids", pageIds.join("|"));
  detailUrl.searchParams.set("redirects", "1");
  detailUrl.searchParams.set("format", "json");
  detailUrl.searchParams.set("origin", "*");

  const detailResponse = await fetchWithRetry(
    fetchImpl,
    detailUrl.toString(),
    {
      headers: {
        accept: "application/json",
        "user-agent": "phoneclaw/0.1 wikipedia-fallback",
      },
    },
    { attempts: 2 }
  ).catch(() => null);
  const detailBody =
    detailResponse && detailResponse.ok
      ? await detailResponse.json().catch(() => ({}))
      : {};
  const pages = detailBody.query?.pages || {};

  const results = searchRows
    .map((row) => {
      const page = pages[String(row.pageid)] || {};
      const title = page.title || cleanHtml(row.title || "") || "Wikipedia result";
      const url = page.fullurl || wikipediaArticleUrl(title);
      const snippet =
        normalizeWhitespace(page.extract || snippetByPageId.get(String(row.pageid)) || "")
          .slice(0, 700);

      return {
        title,
        url,
        snippet,
        source: WIKIPEDIA_PROVIDER,
      };
    })
    .filter((result) => result.url || result.snippet)
    .slice(0, maxResults);

  return {
    ok: true,
    status: "ok",
    provider: WIKIPEDIA_PROVIDER,
    result_count: results.length,
    results,
  };
}

function wikipediaArticleUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(
    String(title || "").replace(/\s+/g, "_")
  )}`;
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

  const response = await fetchWithRetry(
    fetchImpl,
    url.toString(),
    {
      headers: {
        accept: "application/json",
        "user-agent": "phoneclaw/0.1 basic-web-search",
      },
    },
    { attempts: 2 }
  );

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

async function fetchMarketEnrichment(query, now, fetchImpl) {
  if (!isWtiCrudeOilQuery(query)) return null;

  const url = "https://www.tradingview.com/symbols/NYMEX-CL1!/";
  const response = await fetchWithRetry(
    fetchImpl,
    url,
    {
      headers: {
        accept: "text/html",
        "user-agent": "phoneclaw/0.1 market-enrichment",
      },
    },
    { attempts: 2 }
  );
  if (!response.ok) return null;

  const html = await response.text();
  const text = normalizeWhitespace(cleanHtml(html));
  const match = text.match(
    /current price of Light Crude Oil Futures is\s+([0-9,.]+)\s+USD\s*\/\s*BLL\s+—\s+it has\s+(.+?in the past 24 hours)\./i
  );
  if (!match) return null;

  const price = Number.parseFloat(match[1].replace(/,/g, ""));
  if (!Number.isFinite(price)) return null;

  return {
    provider: "TradingView public page",
    instrument: "Light Crude Oil Futures",
    benchmark: "WTI / West Texas Intermediate",
    symbol: "NYMEX:CL1!",
    price,
    currency: "USD",
    unit: "barrel",
    change_text: normalizeWhitespace(match[2]),
    url,
    as_of: now.toISOString(),
  };
}

async function fetchMarketHistoryEnrichment(query, now, fetchImpl) {
  if (!isWtiCrudeOilQuery(query) || !isMarketHistoryQuery(query)) return null;

  const range = marketHistoryRange(query);
  const url = new URL("https://query1.finance.yahoo.com/v8/finance/chart/CL=F");
  url.searchParams.set("range", range);
  url.searchParams.set("interval", "1d");

  const response = await fetchWithRetry(
    fetchImpl,
    url.toString(),
    {
      headers: {
        accept: "application/json",
        "user-agent": "phoneclaw/0.1 market-history",
      },
    },
    { attempts: 2 }
  );
  if (!response.ok) return null;

  const body = await response.json();
  const result = body.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!quote || !Array.isArray(timestamps) || timestamps.length === 0) return null;

  const rows = timestamps
    .map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      high: numberOrNull(quote.high?.[index]),
      low: numberOrNull(quote.low?.[index]),
      close: numberOrNull(quote.close?.[index]),
    }))
    .filter((row) => row.high !== null || row.low !== null || row.close !== null);
  if (rows.length === 0) return null;

  const high = rows
    .filter((row) => row.high !== null)
    .reduce((best, row) => (!best || row.high > best.price ? { date: row.date, price: row.high } : best), null);
  const low = rows
    .filter((row) => row.low !== null)
    .reduce((best, row) => (!best || row.low < best.price ? { date: row.date, price: row.low } : best), null);
  const latest = [...rows].reverse().find((row) => row.close !== null) || rows.at(-1);

  return {
    provider: "Yahoo Finance public chart API",
    instrument: "Light Crude Oil Futures",
    benchmark: "WTI / West Texas Intermediate",
    symbol: "CL=F",
    range,
    interval: "1d",
    currency: result.meta?.currency || "USD",
    unit: "barrel",
    points: rows.length,
    period_start: rows[0].date,
    period_end: rows.at(-1).date,
    highest_price: high,
    lowest_price: low,
    latest_close: latest?.close ?? null,
    latest_close_date: latest?.date || "",
    url: url.toString(),
    as_of: now.toISOString(),
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

function isWtiCrudeOilQuery(query) {
  const value = String(query || "").toLowerCase();
  if (/\b(wti|west texas|west texas intermediate|nymex cl|cl1|cl=f)\b/.test(value)) return true;
  return /\b(oil|crude)\b/.test(value) && /\b(price|down|up|market|futures|barrel)\b/.test(value);
}

function isMarketHistoryQuery(query) {
  return /\b(history|historical|high|highest|peak|range|low|lowest|last\s+\d+\s+days?|last\s+month|past\s+month|30[- ]day|one[- ]month|month)\b/i.test(
    String(query || "")
  );
}

function marketHistoryRange(query) {
  const value = String(query || "").toLowerCase();
  if (/\b(90|ninety|three)\s*(day|days|month|months)\b/.test(value)) return "3mo";
  if (/\b(60|sixty|two)\s*(day|days|month|months)\b/.test(value)) return "3mo";
  return "1mo";
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

function formatAnswerText(
  originalQuery,
  searchedQuery,
  results,
  sports,
  marketData,
  marketHistory
) {
  const sections = [];

  if (marketData) {
    sections.push(
      [
        `${marketData.benchmark} price from ${marketData.provider}: $${marketData.price.toFixed(2)} ${marketData.currency} per ${marketData.unit}.`,
        marketData.change_text ? `Recent change: it has ${marketData.change_text}.` : "",
        `Source: ${marketData.url}`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  if (marketHistory) {
    sections.push(
      [
        `${marketHistory.benchmark} ${marketHistory.range} history from ${marketHistory.provider}:`,
        marketHistory.highest_price
          ? `High: $${marketHistory.highest_price.price.toFixed(2)} ${marketHistory.currency} on ${marketHistory.highest_price.date}.`
          : "",
        marketHistory.lowest_price
          ? `Low: $${marketHistory.lowest_price.price.toFixed(2)} ${marketHistory.currency} on ${marketHistory.lowest_price.date}.`
          : "",
        marketHistory.latest_close !== null
          ? `Latest daily close: $${marketHistory.latest_close.toFixed(2)} ${marketHistory.currency} on ${marketHistory.latest_close_date}.`
          : "",
        `Source: ${marketHistory.url}`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

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

  const response = await fetchWithRetry(
    fetchImpl,
    url.toString(),
    {
      headers: {
        accept: "application/json",
        "user-agent": "phoneclaw/0.1 basic-web-search",
      },
    },
    { attempts: 2 }
  );

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
  const response = await fetchWithRetry(
    fetchImpl,
    "https://html.duckduckgo.com/html/",
    {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "phoneclaw/0.1 basic-web-search",
      },
      body: new URLSearchParams({ q: query }).toString(),
    },
    { attempts: 2 }
  );

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

async function fetchWithRetry(fetchImpl, url, options, { attempts = 2 } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, options);
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === attempts) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }

    await wait(150 * attempt);
  }

  throw lastError || new Error("Request failed.");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanHtml(value) {
  return decodeHtml(String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/[\u00a0\u2009]/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInteger(value, min, max) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}
