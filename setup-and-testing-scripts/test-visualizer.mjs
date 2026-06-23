const baseUrl = (
  process.env.VISUALIZER_BASE_URL ||
  process.env.PHONECLAW_WORKER_BASE_URL ||
  "https://webhooks.aifurman.com"
).replace(/\/$/, "");
const password = process.env.VISUALIZER_PASSWORD;

if (!password) {
  console.error("Missing VISUALIZER_PASSWORD for visualizer login test.");
  process.exit(1);
}

const unauthApi = await fetch(`${baseUrl}/visualizer/api/bootstrap`);
const loginPage = await fetch(`${baseUrl}/visualizer`, { redirect: "manual" });
const login = await fetch(`${baseUrl}/visualizer/login`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password }),
});

const cookie = login.headers.get("set-cookie") || "";
const app = await fetch(`${baseUrl}/visualizer/`, {
  headers: { cookie },
});
const appHtml = await app.text();
const bootstrap = await fetch(`${baseUrl}/visualizer/api/bootstrap?limit=5`, {
  headers: { cookie, accept: "application/json" },
});
const bootstrapBody = await bootstrap.json().catch(() => ({}));

let detailOk = true;
let detailStatus = 0;
const firstConversation =
  bootstrapBody.live_conversations?.items?.[0] ||
  bootstrapBody.archived_conversations?.items?.[0] ||
  null;
if (firstConversation?.conversation_id) {
  const detail = await fetch(
    `${baseUrl}/visualizer/api/conversations/${encodeURIComponent(
      firstConversation.conversation_id
    )}`,
    { headers: { cookie, accept: "application/json" } }
  );
  detailStatus = detail.status;
  const detailBody = await detail.json().catch(() => ({}));
  detailOk = detail.ok && detailBody.ok === true && Boolean(detailBody.conversation?.conversation_id);
}

const checks = {
  unauth_api_blocked: unauthApi.status === 401,
  login_page_served: loginPage.ok && (await loginPage.text()).includes("phone-claw Live"),
  login_redirected: [301, 302, 303, 307, 308].includes(login.status),
  session_cookie_set: cookie.includes("phoneclaw_visualizer="),
  app_served: app.ok && appHtml.includes("phone-claw"),
  bootstrap_ok: bootstrap.ok && bootstrapBody.ok === true,
  live_conversations_array: Array.isArray(bootstrapBody.live_conversations?.items),
  archived_conversations_array: Array.isArray(bootstrapBody.archived_conversations?.items),
  twilio_events_array: Array.isArray(bootstrapBody.twilio_events?.events),
  detail_ok: detailOk,
};

const ok = Object.values(checks).every(Boolean);
console.log(
  JSON.stringify(
    {
      ok,
      base_url: baseUrl,
      statuses: {
        unauth_api: unauthApi.status,
        login_page: loginPage.status,
        login: login.status,
        app: app.status,
        bootstrap: bootstrap.status,
        detail: detailStatus || null,
      },
      returned_counts: {
        live: bootstrapBody.live_conversations?.items?.length ?? null,
        archived: bootstrapBody.archived_conversations?.items?.length ?? null,
        twilio_events: bootstrapBody.twilio_events?.events?.length ?? null,
      },
      checks,
    },
    null,
    2
  )
);

process.exit(ok ? 0 : 1);
