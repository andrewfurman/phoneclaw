const baseUrl = (process.env.MINIFLUX_BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const apiToken = process.env.MINIFLUX_API_TOKEN;
const categoryTitle = process.env.MINIFLUX_ECONOMIST_CATEGORY_TITLE || "Economist";

const economistFeeds = [
  "https://www.economist.com/the-world-this-week/rss.xml",
  "https://www.economist.com/leaders/rss.xml",
  "https://www.economist.com/briefing/rss.xml",
  "https://www.economist.com/united-states/rss.xml",
  "https://www.economist.com/the-americas/rss.xml",
  "https://www.economist.com/asia/rss.xml",
  "https://www.economist.com/china/rss.xml",
  "https://www.economist.com/middle-east-and-africa/rss.xml",
  "https://www.economist.com/europe/rss.xml",
  "https://www.economist.com/britain/rss.xml",
  "https://www.economist.com/international/rss.xml",
  "https://www.economist.com/business/rss.xml",
  "https://www.economist.com/finance-and-economics/rss.xml",
  "https://www.economist.com/science-and-technology/rss.xml",
  "https://www.economist.com/culture/rss.xml",
  "https://www.economist.com/obituary/rss.xml",
  "https://www.economist.com/graphic-detail/rss.xml",
];

if (!apiToken) {
  console.error("Missing MINIFLUX_API_TOKEN.");
  process.exit(1);
}

const category = await ensureCategory(categoryTitle);
const feeds = await requestJson("/v1/feeds");
const existingUrls = new Set(
  (Array.isArray(feeds) ? feeds : []).map((feed) => String(feed.feed_url || ""))
);
const created = [];
const skipped = [];
const failed = [];

for (const feedUrl of economistFeeds) {
  if (existingUrls.has(feedUrl)) {
    skipped.push(feedUrl);
    continue;
  }

  const result = await requestJson("/v1/feeds", {
    method: "POST",
    body: {
      feed_url: feedUrl,
      category_id: category.id,
      crawler: true,
      user_agent:
        "Mozilla/5.0 (compatible; phone-claw-miniflux/1.0; +https://github.com/andrewfurman/phone-claw)",
    },
    allowFailure: true,
  });

  if (result.ok === false) {
    failed.push({
      feed_url: feedUrl,
      status: result.status,
      message: result.message,
    });
    continue;
  }

  created.push({
    feed_url: feedUrl,
    feed_id: result.feed_id || result.id || null,
  });
}

await requestJson(`/v1/categories/${category.id}/refresh`, {
  method: "PUT",
  expectNoContent: true,
});

console.log(
  JSON.stringify(
    {
      ok: true,
      category_id: category.id,
      category_title: category.title,
      created_count: created.length,
      skipped_count: skipped.length,
      failed_count: failed.length,
      created,
      skipped,
      failed,
    },
    null,
    2
  )
);

async function ensureCategory(title) {
  const categories = await requestJson("/v1/categories");
  const existing = (Array.isArray(categories) ? categories : []).find(
    (category) => String(category.title || "").toLowerCase() === title.toLowerCase()
  );
  if (existing) return existing;

  return requestJson("/v1/categories", {
    method: "POST",
    body: { title },
  });
}

async function requestJson(path, {
  method = "GET",
  body,
  expectNoContent = false,
  allowFailure = false,
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      "x-auth-token": apiToken,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (expectNoContent && response.status === 204) return null;

  const text = await response.text();
  const parsed = parseMaybeJson(text);
  if (!response.ok) {
    const failure = {
      ok: false,
      status: response.status,
      message: parsed?.error_message || parsed?.message || text || "Miniflux request failed.",
    };
    if (allowFailure) return failure;
    throw new Error(JSON.stringify(failure));
  }

  return parsed;
}

function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
