import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 80_000;
const MAX_ANSWER_BYTES = 6_000;
const MAX_STEERING_INSTRUCTION_BYTES = 12_000;

const runningJobs = new Map();

export async function claudeCodeTool({
  action = "submit_task",
  task = "",
  repoPath,
  sessionId,
  jobId,
  mode = "run",
  instructions = "",
  confirmed = false,
  maxSeconds,
} = {}) {
  const normalizedAction = normalizeEnum(
    action,
    ["auth_status", "start_session", "submit_task", "job_status", "steer_session"],
    task ? "submit_task" : "auth_status"
  );

  if (normalizedAction === "auth_status") {
    return claudeAuthStatus();
  }

  if (normalizedAction === "start_session") {
    const auth = await claudeAuthStatus();
    const nextSessionId = normalizeUuid(sessionId) || randomUUID();
    return {
      ok: true,
      status: "session_ready",
      action: normalizedAction,
      authenticated: auth.authenticated,
      auth_method: auth.auth_method,
      session_id: nextSessionId,
      answer_text: auth.authenticated
        ? `Claude Code session ${nextSessionId} is ready.`
        : "Claude Code is installed, but it is not authenticated yet.",
    };
  }

  if (normalizedAction === "job_status") {
    const normalizedJobId = normalizeUuid(jobId);
    if (!normalizedJobId) {
      return missingField("job_id", "A Claude Code job_id is required.");
    }
    return claudeJobStatus(normalizedJobId);
  }

  if (normalizedAction === "steer_session") {
    return claudeSteerSession({
      instructions: instructions || task,
      sessionId,
      jobId,
      confirmed,
    });
  }

  const prompt = normalizeString(task);
  if (!prompt) {
    return missingField("task", "A Claude Code task is required.");
  }

  if (!toBoolean(confirmed)) {
    return {
      ok: false,
      status: "confirmation_required",
      action: normalizedAction,
      message:
        "Ask Andrew to confirm the exact Claude Code task, repository, and whether edits/tests should run.",
      answer_text:
        "I need Andrew to confirm the exact Claude Code task and repository before starting it.",
    };
  }

  const auth = await claudeAuthStatus();
  if (!auth.authenticated) {
    return {
      ok: false,
      status: "claude_not_authenticated",
      action: normalizedAction,
      authenticated: false,
      auth_method: auth.auth_method,
      message:
        "Claude Code is installed, but the bridge user is not authenticated yet.",
      answer_text:
        "Claude Code is installed on the bridge, but it is not authenticated yet.",
    };
  }

  const cwdResult = resolveAllowedWorkingDirectory(repoPath);
  if (!cwdResult.ok) return cwdResult;

  const normalizedSessionId = normalizeUuid(sessionId) || randomUUID();
  const normalizedMode = normalizeEnum(mode, ["plan", "run"], "run");
  const timeoutMs =
    clampInteger(maxSeconds, 30, Math.floor(MAX_TIMEOUT_MS / 1000), DEFAULT_TIMEOUT_MS / 1000) *
    1000;
  const normalizedJobId = randomUUID();
  const steeringFile = await ensureSteeringFile(normalizedSessionId);
  const now = new Date().toISOString();
  const job = {
    ok: true,
    status: "running",
    action: normalizedAction,
    job_id: normalizedJobId,
    session_id: normalizedSessionId,
    mode: normalizedMode,
    permission_mode: claudePermissionMode(normalizedMode),
    dangerously_skip_permissions: shouldDangerouslySkipPermissions(normalizedMode),
    working_directory: cwdResult.cwd,
    steering_file: steeringFile,
    steering_instruction_count: 0,
    latest_steering_instruction: "",
    created_at: now,
    updated_at: now,
    exit_code: null,
    signal: null,
    output_text: "",
    output_truncated: false,
    parsed_json: null,
    error_text: "",
    answer_text: `Started Claude Code job ${normalizedJobId}.`,
  };

  runningJobs.set(normalizedJobId, {
    process: null,
    session_id: normalizedSessionId,
    steering_file: steeringFile,
    output: "",
    error: "",
    timeout: null,
  });
  await writeJob(job);

  startClaudeJob({
    job,
    task: buildClaudeTaskPrompt(prompt, normalizedMode, { steeringFile }),
    cwd: cwdResult.cwd,
    sessionId: normalizedSessionId,
    mode: normalizedMode,
    timeoutMs,
  });

  return {
    ok: true,
    status: "running",
    action: normalizedAction,
    job_id: normalizedJobId,
    session_id: normalizedSessionId,
    mode: normalizedMode,
    permission_mode: job.permission_mode,
    dangerously_skip_permissions: job.dangerously_skip_permissions,
    working_directory: cwdResult.cwd,
    steering_file: steeringFile,
    answer_text:
      `Started Claude Code ${normalizedMode} job ${normalizedJobId}. ` +
      "Ask for job status before saying the code work is complete.",
  };
}

async function claudeSteerSession({
  instructions,
  sessionId,
  jobId,
  confirmed = false,
} = {}) {
  const normalizedInstructions = normalizeString(instructions);
  if (!normalizedInstructions) {
    return missingField(
      "instructions",
      "Steering instructions are required before updating a Claude Code session."
    );
  }

  if (!toBoolean(confirmed)) {
    return {
      ok: false,
      status: "confirmation_required",
      action: "steer_session",
      message:
        "Ask Andrew to confirm the exact steering instructions before appending them to the Claude Code session.",
      answer_text:
        "I need Andrew to confirm the exact steering instructions before updating the Claude Code session.",
    };
  }

  const normalizedJobId = normalizeUuid(jobId);
  const running = normalizedJobId ? runningJobs.get(normalizedJobId) : null;
  const storedJob = normalizedJobId ? await readJob(normalizedJobId).catch(() => null) : null;
  if (normalizedJobId && !running && !storedJob) {
    return {
      ok: false,
      status: "job_not_found",
      action: "steer_session",
      job_id: normalizedJobId,
      answer_text: `I could not find Claude Code job ${normalizedJobId}.`,
    };
  }

  const normalizedSessionId =
    normalizeUuid(sessionId) ||
    normalizeUuid(running?.session_id) ||
    normalizeUuid(storedJob?.session_id);
  if (!normalizedSessionId) {
    return missingField(
      "session_id",
      "A Claude Code session_id or known job_id is required for steering instructions."
    );
  }

  const record = await appendSteeringInstruction({
    sessionId: normalizedSessionId,
    jobId: normalizedJobId,
    instructions: normalizedInstructions,
  });
  const runningJob = Boolean(
    running ||
      [...runningJobs.values()].some((item) => item.session_id === normalizedSessionId)
  );

  return {
    ok: true,
    status: "steering_recorded",
    action: "steer_session",
    session_id: normalizedSessionId,
    job_id: normalizedJobId,
    steering_id: record.steering_id,
    steering_file: record.steering_file,
    running_job: runningJob,
    instructions_preview: truncateUtf8(redact(normalizedInstructions), 600).value,
    answer_text: runningJob
      ? "Added steering instructions to the active Claude Code session."
      : "Recorded steering instructions for that Claude Code session.",
  };
}

async function claudeAuthStatus() {
  const command = process.env.CLAUDE_BIN || "claude";
  const result = await runCommand(command, ["auth", "status", "--json"], {
    timeoutMs: 15_000,
    cwd: process.cwd(),
  });
  const parsed = parseMaybeJson(result.stdout);
  const authenticated =
    parsed?.loggedIn === true ||
    Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_API_KEY);
  const statusReadable = Boolean(parsed && typeof parsed === "object");

  return {
    ok: statusReadable || result.ok,
    status: statusReadable || result.ok ? "ok" : "claude_auth_status_failed",
    action: "auth_status",
    authenticated,
    auth_method: parsed?.authMethod || (process.env.ANTHROPIC_API_KEY ? "api_key" : "none"),
    api_provider: parsed?.apiProvider || "",
    raw_status: parsed,
    message: result.ok ? "" : result.stderr || result.error_message,
    answer_text: authenticated
      ? "Claude Code is authenticated on the bridge."
      : "Claude Code is not authenticated on the bridge yet.",
  };
}

async function claudeJobStatus(jobId) {
  const running = runningJobs.get(jobId);
  if (running) {
    const job = await readJob(jobId).catch(() => null);
    const withSteering = await attachSteeringMetadata(job || {
      job_id: jobId,
      session_id: running.session_id,
      steering_file: running.steering_file,
    });
    return {
      ...withSteering,
      ok: true,
      status: "running",
      job_id: jobId,
      output_preview: truncateUtf8(redact(running.output), MAX_ANSWER_BYTES).value,
      answer_text: `Claude Code job ${jobId} is still running.`,
    };
  }

  const job = await readJob(jobId).catch(() => null);
  if (!job) {
    return {
      ok: false,
      status: "job_not_found",
      job_id: jobId,
      answer_text: `I could not find Claude Code job ${jobId}.`,
    };
  }

  return {
    ...(await attachSteeringMetadata(job)),
    output_preview: claudeOutputPreview(job),
    answer_text:
      job.status === "completed"
        ? `Claude Code job ${jobId} completed.`
        : `Claude Code job ${jobId} ended with status ${job.status}.`,
  };
}

function claudeOutputPreview(job) {
  const result = job.parsed_json?.result;
  const text = typeof result === "string" && result.trim() ? result : job.output_text || "";
  return truncateUtf8(text, MAX_ANSWER_BYTES).value;
}

function startClaudeJob({ job, task, cwd, sessionId, mode, timeoutMs }) {
  const command = process.env.CLAUDE_BIN || "claude";
  const permissionMode = claudePermissionMode(mode);
  const skipPermissions = shouldDangerouslySkipPermissions(mode);
  const args = [
    "-p",
    task,
    "--output-format",
    "json",
    "--session-id",
    sessionId,
    "--permission-mode",
    permissionMode,
  ];

  if (skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  const allowedTools = skipPermissions ? [] : claudeAllowedTools(mode);
  if (!skipPermissions && allowedTools.length > 0) {
    args.push("--allowedTools", ...allowedTools);
  }

  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const running = runningJobs.get(job.job_id);
  running.process = child;
  running.timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, timeoutMs);

  child.stdout.on("data", (chunk) => {
    running.output = truncateUtf8(`${running.output}${chunk.toString("utf8")}`, MAX_OUTPUT_BYTES).value;
  });
  child.stderr.on("data", (chunk) => {
    running.error = truncateUtf8(`${running.error}${chunk.toString("utf8")}`, 20_000).value;
  });
  child.on("error", async (error) => {
    clearTimeout(running.timeout);
    runningJobs.delete(job.job_id);
    await writeJob({
      ...job,
      status: "failed_to_start",
      updated_at: new Date().toISOString(),
      error_text: redact(error.message),
      answer_text: `Claude Code job ${job.job_id} failed to start.`,
    });
  });
  child.on("close", async (code, signal) => {
    clearTimeout(running.timeout);
    runningJobs.delete(job.job_id);
    const output = redact(running.output);
    const errorText = redact(running.error);
    const parsed = parseMaybeJson(output);
    const timedOut = signal === "SIGTERM" && code === null;
    const status = timedOut ? "timed_out" : code === 0 ? "completed" : "failed";
    const steeringMetadata = await steeringJobMetadata(job.session_id);
    await writeJob({
      ...job,
      ...steeringMetadata,
      status,
      updated_at: new Date().toISOString(),
      exit_code: code,
      signal,
      output_text: output,
      output_truncated: Buffer.byteLength(output, "utf8") >= MAX_OUTPUT_BYTES,
      parsed_json: parsed,
      error_text: errorText,
      answer_text:
        status === "completed"
          ? `Claude Code job ${job.job_id} completed.`
          : `Claude Code job ${job.job_id} ended with status ${status}.`,
    });
  });
}

function buildClaudeTaskPrompt(task, mode, { steeringFile = "" } = {}) {
  const guardrails = [
    "You are running from phone claw's voice-agent bridge on an EC2 host.",
    "Work only in the current repository unless the user explicitly named another allowed path.",
    "Do not push commits, deploy, rotate secrets, or perform destructive operations unless the user explicitly requested that exact action.",
    "Do not reveal secrets or credential values. Redact any secret-like value you encounter.",
  ];

  if (steeringFile) {
    guardrails.push(
      `This session has a steering instruction file at ${steeringFile}. Re-read it before planning, before editing files, before running verification, and before your final answer. Each JSONL line is an instruction record from Andrew; later records override or refine earlier ones. If a new steering instruction conflicts with the original task, follow the latest steering instruction and mention the change in your final summary.`
    );
  }

  if (mode === "plan") {
    guardrails.push("Plan only. Do not edit files or run mutating commands.");
  } else {
    guardrails.push("Make the requested code changes and run the most relevant verification commands you can.");
  }

  return `${guardrails.join("\n")}\n\nTask from Andrew via voice agent:\n${task}`;
}

function claudePermissionMode(mode) {
  if (mode === "plan") return "plan";
  if (shouldDangerouslySkipPermissions(mode)) return "bypassPermissions";
  return process.env.CLAUDE_CODE_PERMISSION_MODE || "acceptEdits";
}

function shouldDangerouslySkipPermissions(mode) {
  if (mode === "plan") return false;
  return toBoolean(process.env.CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS, false);
}

function claudeAllowedTools(mode) {
  const fromEnv = normalizeString(process.env.CLAUDE_CODE_ALLOWED_TOOLS);
  if (fromEnv) {
    return fromEnv
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (mode === "plan") {
    return ["Read", "Grep", "Glob", "LS", "Bash(git status*)", "Bash(git diff*)"];
  }

  return [
    "Read",
    "Grep",
    "Glob",
    "LS",
    "Edit",
    "MultiEdit",
    "Write",
    "Bash(git status*)",
    "Bash(git diff*)",
    "Bash(git log*)",
    "Bash(npm*)",
    "Bash(node*)",
  ];
}

function resolveAllowedWorkingDirectory(repoPath) {
  const requested = normalizeString(repoPath, process.cwd());
  const cwd = resolve(requested);
  const allowedDirs = (process.env.CLAUDE_CODE_ALLOWED_DIRS || process.cwd())
    .split(",")
    .map((item) => resolve(normalizeString(item)))
    .filter(Boolean);

  const allowed = allowedDirs.some((allowedDir) => {
    const rel = relative(allowedDir, cwd);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
  });

  if (!allowed) {
    return {
      ok: false,
      status: "working_directory_not_allowed",
      working_directory: cwd,
      allowed_directories: allowedDirs,
      answer_text: "That repository path is not in the Claude Code bridge allow-list.",
    };
  }

  return { ok: true, cwd };
}

async function runCommand(command, args, { timeoutMs, cwd }) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = truncateUtf8(`${stdout}${chunk.toString("utf8")}`, 20_000).value;
    });
    child.stderr.on("data", (chunk) => {
      stderr = truncateUtf8(`${stderr}${chunk.toString("utf8")}`, 20_000).value;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolveResult({
        ok: false,
        stdout: "",
        stderr: "",
        error_message: error.message,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({
        ok: code === 0,
        exit_code: code,
        signal,
        stdout: redact(stdout),
        stderr: redact(stderr),
      });
    });
  });
}

async function readJob(jobId) {
  return JSON.parse(await readFile(jobPath(jobId), "utf8"));
}

async function writeJob(job) {
  await mkdir(jobDir(), { recursive: true });
  await writeFile(jobPath(job.job_id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

function jobDir() {
  return process.env.CLAUDE_CODE_JOB_DIR || resolve(process.cwd(), ".phoneclaw", "claude-jobs");
}

function jobPath(jobId) {
  return resolve(jobDir(), `${jobId}.json`);
}

async function ensureSteeringFile(sessionId) {
  const filePath = steeringPath(sessionId);
  await mkdir(steeringDir(), { recursive: true });
  await appendFile(filePath, "", "utf8");
  return filePath;
}

async function appendSteeringInstruction({ sessionId, jobId, instructions }) {
  const filePath = await ensureSteeringFile(sessionId);
  const record = {
    steering_id: randomUUID(),
    created_at: new Date().toISOString(),
    session_id: sessionId,
    job_id: jobId || "",
    instructions: truncateUtf8(redact(instructions), MAX_STEERING_INSTRUCTION_BYTES).value,
  };
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  return {
    ...record,
    steering_file: filePath,
  };
}

async function readSteeringInstructions(sessionId) {
  const normalizedSessionId = normalizeUuid(sessionId);
  if (!normalizedSessionId) return [];

  const text = await readFile(steeringPath(normalizedSessionId), "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseMaybeJson)
    .filter((item) => item && typeof item === "object");
}

async function steeringJobMetadata(sessionId) {
  const instructions = await readSteeringInstructions(sessionId);
  const latest = instructions.at(-1);
  return {
    steering_file: normalizeUuid(sessionId) ? steeringPath(sessionId) : "",
    steering_instruction_count: instructions.length,
    latest_steering_instruction: latest?.instructions
      ? truncateUtf8(latest.instructions, 1_000).value
      : "",
  };
}

async function attachSteeringMetadata(job) {
  if (!job) return job;
  return {
    ...job,
    ...(await steeringJobMetadata(job.session_id)),
  };
}

function steeringDir() {
  return process.env.CLAUDE_CODE_STEERING_DIR || resolve(jobDir(), "steering");
}

function steeringPath(sessionId) {
  return resolve(steeringDir(), `${normalizeUuid(sessionId)}.jsonl`);
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
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeString(value).toLowerCase().replaceAll("-", "_");
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeUuid(value) {
  const normalized = normalizeString(value).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    normalized
  )
    ? normalized
    : "";
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return Boolean(value);
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { value: text, truncated: false };
  }

  return {
    value: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

function redact(value) {
  return String(value || "")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_[redacted]")
    .replace(/gh[opsu]_[A-Za-z0-9_]+/g, "gh_[redacted]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token":"[redacted]"')
    .replace(/"api[_-]?key"\s*:\s*"[^"]+"/gi, '"api_key":"[redacted]"');
}
