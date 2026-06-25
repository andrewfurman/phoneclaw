import assert from "node:assert/strict";
import { basicWebSearch } from "../shared/basic-web-search.mjs";

const cases = [
  {
    name: "uses Tavily when configured and non-empty",
    options: {
      provider: "auto",
      tavilyApiKey: "test-key",
      fetchImpl: mockFetch({
        tavily: { ok: true, answer: "Tavily answer", results: [searchResult("Tavily result")] },
      }),
    },
    expect: {
      provider: "Tavily",
      resultCount: 2,
      diagnostics: ["Tavily"],
    },
  },
  {
    name: "falls back from empty Tavily to DuckDuckGo",
    options: {
      provider: "auto",
      tavilyApiKey: "test-key",
      fetchImpl: mockFetch({
        tavily: { ok: true, answer: "", results: [] },
        duckInstant: {
          Heading: "Duck heading",
          AbstractText: "",
          Answer: "",
          RelatedTopics: [
            {
              Text: "Duck result - Duck snippet",
              FirstURL: "https://duck.example/result",
            },
          ],
        },
      }),
    },
    expect: {
      provider: "DuckDuckGo",
      resultCount: 1,
      diagnostics: ["Tavily", "DuckDuckGo"],
    },
  },
  {
    name: "falls back from failed Tavily and empty DuckDuckGo to Wikipedia",
    options: {
      provider: "auto",
      tavilyApiKey: "test-key",
      fetchImpl: mockFetch({
        tavily: { ok: false, status: 500, body: { message: "temporary Tavily error" } },
        duckInstant: emptyDuckInstant(),
        duckHtml: "",
        wikipediaSearch: [wikipediaSearchRow()],
        wikipediaPages: {
          123: {
            pageid: 123,
            title: "United States",
            fullurl: "https://en.wikipedia.org/wiki/United_States",
            extract: "The United States is a country with a large population.",
          },
        },
      }),
    },
    expect: {
      provider: "Wikipedia",
      resultCount: 1,
      diagnostics: ["Tavily", "DuckDuckGo", "Wikipedia"],
    },
  },
  {
    name: "retries transient Tavily errors before falling back",
    options: {
      provider: "auto",
      tavilyApiKey: "test-key",
      fetchImpl: retryingTavilyFetch(),
    },
    expect: {
      provider: "Tavily",
      resultCount: 2,
      diagnostics: ["Tavily"],
    },
  },
  {
    name: "returns controlled empty result when every no-key provider is empty",
    options: {
      provider: "duckduckgo",
      fetchImpl: mockFetch({
        duckInstant: emptyDuckInstant(),
        duckHtml: "",
        wikipediaSearch: [],
      }),
    },
    expect: {
      provider: "DuckDuckGo",
      resultCount: 0,
      diagnostics: ["DuckDuckGo", "Wikipedia"],
    },
  },
];

const results = [];
for (const testCase of cases) {
  const result = await basicWebSearch({
    query: "United States population",
    maxResults: 5,
    ...testCase.options,
  });

  assert.equal(result.ok, true, testCase.name);
  assert.equal(result.provider, testCase.expect.provider, testCase.name);
  assert.equal(result.result_count, testCase.expect.resultCount, testCase.name);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.provider),
    testCase.expect.diagnostics,
    testCase.name
  );

  results.push({
    name: testCase.name,
    provider: result.provider,
    result_count: result.result_count,
    diagnostics: result.diagnostics,
  });
}

console.log(JSON.stringify({ ok: true, results }, null, 2));

function mockFetch({
  tavily = { ok: true, answer: "", results: [] },
  duckInstant = emptyDuckInstant(),
  duckHtml = "",
  wikipediaSearch = [],
  wikipediaPages = {},
} = {}) {
  return async (url) => {
    const value = String(url);

    if (value === "https://api.tavily.com/search") {
      const status = tavily.status || (tavily.ok === false ? 500 : 200);
      return jsonResponse(
        tavily.ok === false
          ? tavily.body || { message: "Tavily failed" }
          : {
              answer: tavily.answer || "",
              results: tavily.results || [],
            },
        status
      );
    }

    if (value.includes("api.duckduckgo.com")) {
      return jsonResponse(duckInstant, 200);
    }

    if (value.includes("html.duckduckgo.com")) {
      return textResponse(duckHtml, 200);
    }

    if (value.includes("en.wikipedia.org/w/api.php")) {
      const apiUrl = new URL(value);
      if (apiUrl.searchParams.get("list") === "search") {
        return jsonResponse({ query: { search: wikipediaSearch } }, 200);
      }
      return jsonResponse({ query: { pages: wikipediaPages } }, 200);
    }

    throw new Error(`Unexpected fetch URL: ${value}`);
  };
}

function retryingTavilyFetch() {
  let tavilyAttempts = 0;

  return async (url) => {
    const value = String(url);
    if (value === "https://api.tavily.com/search") {
      tavilyAttempts += 1;
      if (tavilyAttempts === 1) {
        return jsonResponse({ message: "try again" }, 503);
      }
      return jsonResponse(
        {
          answer: "Recovered Tavily answer",
          results: [searchResult("Recovered Tavily result")],
        },
        200
      );
    }

    throw new Error(`Unexpected fetch URL after Tavily retry success: ${value}`);
  };
}

function searchResult(title) {
  return {
    title,
    url: `https://example.com/${title.toLowerCase().replace(/\s+/g, "-")}`,
    content: `${title} snippet`,
    score: 0.9,
  };
}

function emptyDuckInstant() {
  return {
    Heading: "",
    AbstractText: "",
    Answer: "",
    RelatedTopics: [],
  };
}

function wikipediaSearchRow() {
  return {
    pageid: 123,
    title: "United States",
    snippet: "United States population snippet",
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body, status) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}
