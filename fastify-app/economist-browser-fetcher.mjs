import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { htmlToText } from "html-to-text";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_WAIT_MS = 6_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149 Safari/537.36";

let browserFetchQueue = Promise.resolve();

export function economistBrowserFetchConfigured() {
  return toBoolean(process.env.ECONOMIST_BROWSER_FETCH_ENABLED, false);
}

export async function fetchEconomistArticleWithBrowser({
  url,
  maxTextChars = 30_000,
} = {}) {
  if (!economistBrowserFetchConfigured()) {
    return {
      ok: false,
      status: "economist_browser_not_configured",
      message: "ECONOMIST_BROWSER_FETCH_ENABLED is not true.",
    };
  }

  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl.ok) return normalizedUrl;

  const run = browserFetchQueue.then(() =>
    fetchWithBrowser({
      url: normalizedUrl.url,
      maxTextChars,
    })
  );
  browserFetchQueue = run.catch(() => {});
  return run;
}

async function fetchWithBrowser({ url, maxTextChars }) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch (error) {
    return {
      ok: false,
      status: "playwright_not_installed",
      message: `Playwright is not installed: ${error.message}`,
    };
  }

  const chromium = playwright.chromium;
  const launchOptions = {
    headless: toBoolean(process.env.ECONOMIST_BROWSER_HEADLESS, true),
    timeout: envInteger("ECONOMIST_BROWSER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    args: [
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };
  const executablePath = normalizeString(process.env.ECONOMIST_BROWSER_EXECUTABLE_PATH);
  if (executablePath) launchOptions.executablePath = executablePath;
  if (toBoolean(process.env.ECONOMIST_BROWSER_NO_SANDBOX, true)) {
    launchOptions.args.push("--no-sandbox");
  }

  const contextOptions = {
    viewport: { width: 1365, height: 900 },
    locale: "en-US",
    timezoneId: process.env.TZ || "America/Los_Angeles",
    userAgent: normalizeString(process.env.ECONOMIST_BROWSER_USER_AGENT, DEFAULT_USER_AGENT),
  };
  const storageStatePath = normalizeString(process.env.ECONOMIST_BROWSER_STORAGE_STATE);
  if (storageStatePath && (await fileExists(storageStatePath))) {
    contextOptions.storageState = storageStatePath;
  }

  const userDataDir = normalizeString(process.env.ECONOMIST_BROWSER_USER_DATA_DIR);
  let browser;
  let context;
  let page;
  try {
    if (userDataDir) {
      await mkdir(userDataDir, { recursive: true });
      context = await chromium.launchPersistentContext(userDataDir, {
        ...launchOptions,
        ...contextOptions,
      });
    } else {
      browser = await chromium.launch(launchOptions);
      context = await browser.newContext(contextOptions);
    }

    page = await context.newPage();
    page.setDefaultTimeout(envInteger("ECONOMIST_BROWSER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
    page.setDefaultNavigationTimeout(
      envInteger("ECONOMIST_BROWSER_NAVIGATION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)
    );

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: envInteger("ECONOMIST_BROWSER_NAVIGATION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    });
    await page
      .waitForLoadState("networkidle", {
        timeout: envInteger("ECONOMIST_BROWSER_NETWORK_IDLE_TIMEOUT_MS", 5_000),
      })
      .catch(() => {});
    await page.waitForTimeout(envInteger("ECONOMIST_BROWSER_WAIT_MS", DEFAULT_WAIT_MS));

    const extracted = await page.evaluate(() => {
      const blockedByCloudflare =
        Boolean(document.querySelector('[name="cf_chl_opt"], #cf-challenge-running')) ||
        /Cloudflare|cf-chl|Enable JavaScript and cookies|checking your browser/i.test(
          document.body?.innerText || ""
        );
      const bodyText = document.body?.innerText || "";
      const title =
        document.querySelector("h1")?.textContent?.trim() ||
        document.querySelector("meta[property='og:title']")?.getAttribute("content")?.trim() ||
        document.title ||
        "";
      const description =
        document
          .querySelector("meta[name='description'], meta[property='og:description']")
          ?.getAttribute("content")
          ?.trim() || "";
      const selectors = [
        "article",
        "main article",
        "main [data-testid*='article']",
        "main [data-test-id*='article']",
        "main [class*='article']",
        "main",
      ];
      const candidates = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .map((node) => ({
          selector: node.tagName?.toLowerCase() || "",
          text: node.textContent || "",
          html: node.innerHTML || "",
        }))
        .filter((candidate) => candidate.text.trim().length > 0)
        .sort((left, right) => right.text.length - left.text.length);
      const best = candidates[0] || {
        selector: "body",
        text: bodyText,
        html: document.body?.innerHTML || "",
      };

      return {
        title,
        description,
        final_url: location.href,
        blocked_by_cloudflare: blockedByCloudflare,
        body_text: bodyText,
        article_selector: best.selector,
        article_html: best.html,
      };
    });

    if (storageStatePath) {
      await mkdir(dirname(storageStatePath), { recursive: true });
      await context.storageState({ path: storageStatePath }).catch(() => {});
    }

    const text = extractReadableText(extracted);
    const boundedMax = clampInteger(maxTextChars, 2_000, 120_000, 30_000);
    const truncated = truncateText(text, boundedMax);
    const status = articleStatus({ extracted, text, responseStatus: response?.status() || 0 });

    return {
      ok: status === "ok",
      status,
      provider: "playwright",
      source: "economist",
      url,
      final_url: extracted.final_url || url,
      http_status: response?.status() || null,
      title: extracted.title || "",
      description: extracted.description || "",
      article_selector: extracted.article_selector || "",
      full_text_chars: text.length,
      returned_text_chars: truncated.value.length,
      full_text_truncated: truncated.truncated,
      full_text: truncated.value,
      message: browserMessage({ status, extracted, text }),
    };
  } catch (error) {
    return {
      ok: false,
      status: "economist_browser_fetch_failed",
      message: error.message,
      url,
    };
  } finally {
    try {
      await page?.close();
    } catch {}
    try {
      await context?.close();
    } catch {}
    try {
      await browser?.close();
    } catch {}
  }
}

function extractReadableText(extracted) {
  const htmlText = htmlToText(extracted.article_html || "", {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "aside", format: "skip" },
      { selector: "button", format: "skip" },
      { selector: "footer", format: "skip" },
      { selector: "form", format: "skip" },
      { selector: "img", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "svg", format: "skip" },
    ],
  });
  const fallback = extracted.body_text || "";
  const text = htmlText.length >= 200 ? htmlText : fallback;
  return normalizeArticleText(text);
}

function articleStatus({ extracted, text, responseStatus }) {
  if (responseStatus === 403 || extracted.blocked_by_cloudflare) {
    return "economist_browser_blocked_by_cloudflare";
  }
  if (requiresLogin(text)) {
    return "economist_browser_login_required";
  }
  if (text.length < 700) {
    return "economist_browser_excerpt_only";
  }
  return "ok";
}

function browserMessage({ status, extracted, text }) {
  if (status === "ok") return "Browser fetch returned readable article text.";
  if (status === "economist_browser_blocked_by_cloudflare") {
    return "The browser fetch is still seeing a Cloudflare challenge. Authenticate the EC2 browser profile and try again.";
  }
  if (status === "economist_browser_login_required") {
    return "The browser fetch reached The Economist but appears to need a subscriber login.";
  }
  if (status === "economist_browser_excerpt_only") {
    return `The browser fetch returned only ${text.length} characters, so it is probably an excerpt.`;
  }
  return extracted?.description || "The browser fetch did not return full article text.";
}

function requiresLogin(value) {
  const text = String(value || "").toLowerCase();
  return [
    /\bsign in\s+(to|for)\s+(continue|read|access|unlock)\b/,
    /\blog in\s+(to|for)\s+(continue|read|access|unlock)\b/,
    /\bsubscribe\s+(to|for)\s+(continue|read|access|unlock)\b/,
    /\bsubscribe now\b/,
    /\bstart (your )?(free )?trial\b/,
    /\bcreate (an )?account\s+(to|for)\s+(continue|read|access|unlock)\b/,
    /\byou need to be (signed|logged) in\b/,
  ].some((pattern) => pattern.test(text));
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !(hostname === "economist.com" || hostname.endsWith(".economist.com"))) {
      return {
        ok: false,
        status: "invalid_economist_url",
        message: "Only https://*.economist.com article URLs are supported.",
      };
    }
    return { ok: true, url: url.toString() };
  } catch {
    return {
      ok: false,
      status: "invalid_url",
      message: "A valid Economist article URL is required.",
    };
  }
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

function normalizeString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return Boolean(value);
}

function envInteger(name, fallback) {
  return clampInteger(process.env[name], 1, 300_000, fallback);
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

async function fileExists(pathname) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}
