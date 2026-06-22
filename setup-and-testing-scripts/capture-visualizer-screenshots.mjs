import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = (
  process.env.VISUALIZER_BASE_URL ||
  process.env.PHONECLAW_VISUALIZER_BASE_URL ||
  "https://webhooks.aifurman.com"
).replace(/\/$/, "");
const password = process.env.VISUALIZER_PASSWORD;
const conversationId = process.env.VISUALIZER_CONVERSATION_ID || "";
const outputDir = process.env.VISUALIZER_SCREENSHOT_DIR || "/tmp/phoneclaw-visualizer";

if (!password) {
  console.error("Missing VISUALIZER_PASSWORD for screenshot capture.");
  process.exit(1);
}

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const screenshots = [];

try {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 980 },
    { name: "mobile", width: 390, height: 844, isMobile: true },
  ]) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: Boolean(viewport.isMobile),
    });
    await login(page);
    if (conversationId) {
      await page.goto(
        `${baseUrl}/visualizer/conversation/${encodeURIComponent(conversationId)}`,
        { waitUntil: "networkidle" }
      );
    }
    await page.waitForSelector(".conversation-detail", { timeout: 20_000 });
    await page.waitForTimeout(900);

    const screenshotPath = path.join(outputDir, `phoneclaw-visualizer-${viewport.name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const metrics = await page.evaluate(() => ({
      title: document.querySelector("h1")?.textContent || "",
      selectedConversation: document.querySelector(".detail-header h2")?.textContent || "",
      toolCards: document.querySelectorAll(".tool-card").length,
      actionLinks: document.querySelectorAll(".link-chip").length,
      transcriptTurns: document.querySelectorAll(".turn").length,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      bodyHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
    }));

    screenshots.push({
      name: viewport.name,
      path: screenshotPath,
      metrics,
    });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ ok: true, base_url: baseUrl, conversation_id: conversationId, screenshots }, null, 2));

async function login(page) {
  await page.goto(`${baseUrl}/visualizer`, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[name="password"]').count()) {
    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.click('button[type="submit"]'),
    ]);
  } else {
    await page.waitForLoadState("networkidle");
  }
}
