import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { himalayaEmailArchive } from "../fastify-app/cli-tools.mjs";

const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;

const local = await runLocalBatchArchiveValidation();
const live = toolToken ? await runLiveConfirmationValidation() : { skipped: true };
const ok = local.ok && (live.skipped || live.ok);

console.log(JSON.stringify({ ok, local, live }, null, 2));
process.exit(ok ? 0 : 1);

async function runLocalBatchArchiveValidation() {
  const directory = await mkdtemp(path.join(tmpdir(), "phoneclaw-himalaya-archive-"));
  const logPath = path.join(directory, "calls.jsonl");
  const fakeBin = path.join(directory, "himalaya-fake.sh");
  await writeFile(
    fakeBin,
    `#!/bin/sh\nprintf '%s\\n' \"$*\" >> ${JSON.stringify(logPath)}\nprintf '{\"moved\":true}\\n'\n`
  );
  await chmod(fakeBin, 0o755);

  const originalBin = process.env.HIMALAYA_BIN;
  process.env.HIMALAYA_BIN = fakeBin;
  try {
    const result = await himalayaEmailArchive({
      ids: ["archive-a", "archive-b", "archive-a"],
      folder: "INBOX",
      archiveFolder: "[Gmail]/All Mail",
      confirmed: true,
    });
    const log = await readFile(logPath, "utf8");
    const calls = log.trim().split("\n").filter(Boolean);
    return {
      ok:
        result.ok === true &&
        result.archived_count === 2 &&
        result.failed_count === 0 &&
        result.ids?.length === 2 &&
        calls.length === 2 &&
        calls.every((line) => line.includes("message move")) &&
        calls[0].includes("archive-a") &&
        calls[1].includes("archive-b"),
      result: {
        ok: result.ok,
        action: result.action,
        archived_count: result.archived_count,
        failed_count: result.failed_count,
        ids: result.ids,
        answer_text: result.answer_text,
      },
      calls,
    };
  } finally {
    if (originalBin) {
      process.env.HIMALAYA_BIN = originalBin;
    } else {
      delete process.env.HIMALAYA_BIN;
    }
  }
}

async function runLiveConfirmationValidation() {
  const response = await fetch(`${workerBaseUrl}/cli/himalaya/email-archive`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${toolToken}`,
    },
    body: JSON.stringify({
      ids: ["validation-a", "validation-b"],
      folder: "INBOX",
      confirmed: false,
    }),
  });
  const text = await response.text();
  const body = parseMaybeJson(text);
  return {
    ok:
      response.status === 200 &&
      body?.status === "confirmation_required" &&
      /2 selected emails/.test(body?.answer_text || ""),
    status: response.status,
    body_status: body?.status || "",
    answer_text: body?.answer_text || "",
  };
}

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
