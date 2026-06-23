import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = await mkdtemp(join(tmpdir(), "phoneclaw-claude-steering-"));
process.env.CLAUDE_CODE_JOB_DIR = join(tempDir, "jobs");
process.env.CLAUDE_CODE_STEERING_DIR = join(tempDir, "steering");

const { claudeCodeTool } = await import("../fastify-app/claude-code-tools.mjs");

const sessionId = randomUUID();
const instructions =
  "Steer this Claude Code session to update the README naming first, then rerun checks.";

try {
  const unconfirmed = await claudeCodeTool({
    action: "steer_session",
    sessionId,
    instructions,
    confirmed: false,
  });
  const recorded = await claudeCodeTool({
    action: "steer_session",
    sessionId,
    instructions,
    confirmed: true,
  });
  const steeringText = await readFile(recorded.steering_file, "utf8");
  const records = steeringText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const record = records[0];

  const checks = {
    unconfirmed_requires_confirmation: unconfirmed.status === "confirmation_required",
    recorded_ok: recorded.ok === true && recorded.status === "steering_recorded",
    session_id_preserved: recorded.session_id === sessionId,
    record_written: records.length === 1,
    record_has_instruction: record?.instructions === instructions,
    record_has_steering_id: Boolean(record?.steering_id),
  };
  const ok = Object.values(checks).every(Boolean);

  console.log(
    JSON.stringify(
      {
        ok,
        checks,
        recorded: {
          status: recorded.status,
          action: recorded.action,
          session_id: recorded.session_id,
          running_job: recorded.running_job,
        },
      },
      null,
      2
    )
  );

  process.exit(ok ? 0 : 1);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
