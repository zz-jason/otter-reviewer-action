#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_API_URL = "https://api.github.com";
const MAX_LOG_CHARS = 64 * 1024;

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function requiredEnv(name) {
  const value = env(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function boolEnv(name, fallback) {
  const raw = env(name, fallback ? "true" : "false").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function numberEnv(name, fallback) {
  const raw = env(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function truncateForLog(text) {
  if (!text || text.length <= MAX_LOG_CHARS) return text || "";
  return `${text.slice(0, MAX_LOG_CHARS)}\n[output truncated]`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: 100 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${truncateForLog(result.stderr)}` : "";
    const stdout = result.stdout ? `\n${truncateForLog(result.stdout)}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${stderr}${stdout}`);
  }

  if (result.stdout) process.stdout.write(truncateForLog(result.stdout));
  if (result.stderr) process.stderr.write(truncateForLog(result.stderr));
  return result.stdout || "";
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: 100 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${truncateForLog(result.stderr || result.stdout)}`);
  }
  return result.stdout.trim();
}

function parseJsonArrayText(raw, name) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be a JSON array`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return parsed;
}

function parseJsonArrayEnv(name, fallback = []) {
  const raw = env(name);
  if (!raw) return fallback;
  return parseJsonArrayText(raw, name);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    // Agents should honor the schema, but keep this tolerant for older CLIs.
  }

  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) return JSON.parse(fenced[1]);

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }

  throw new Error("Agent output did not contain a JSON object");
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function normalizePrivateKey(raw) {
  const unescaped = raw.replace(/\\n/g, "\n").trim();
  if (unescaped.includes("BEGIN")) return unescaped;

  const decoded = Buffer.from(unescaped, "base64").toString("utf8").trim();
  if (decoded.includes("BEGIN")) return decoded;

  throw new Error("OTTER_REVIEWER_PRIVATE_KEY must be PEM text or base64-encoded PEM text");
}

function createAppJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: String(appId) };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

async function githubJson(method, apiUrl, route, token, body, bearer = false) {
  const response = await fetch(`${apiUrl}${route}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `${bearer ? "Bearer" : "token"} ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "otter-reviewer",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = parsed && parsed.message ? parsed.message : text;
    throw new Error(`${method} ${route} failed with ${response.status}: ${message}`);
  }
  return parsed;
}

async function createInstallationToken({ apiUrl, owner, repo }) {
  const appId = requiredEnv("OTTER_REVIEWER_APP_ID");
  const privateKey = normalizePrivateKey(requiredEnv("OTTER_REVIEWER_PRIVATE_KEY"));
  const jwt = createAppJwt(appId, privateKey);
  let installationId = env("OTTER_REVIEWER_INSTALLATION_ID");

  if (!installationId) {
    const installation = await githubJson(
      "GET",
      apiUrl,
      `/repos/${owner}/${repo}/installation`,
      jwt,
      undefined,
      true
    );
    installationId = String(installation.id);
  }

  const token = await githubJson(
    "POST",
    apiUrl,
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    {
      repositories: [repo],
      permissions: {
        contents: "read",
        pull_requests: "write",
      },
    },
    true
  );

  return token.token;
}

function parseAllowedLines(diffText) {
  const allowed = new Map();
  let currentPath = null;
  let newLine = null;

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      newLine = null;
      continue;
    }

    if (line.startsWith("+++ ")) {
      const file = line.slice(4).trim();
      if (file === "/dev/null") {
        currentPath = null;
      } else {
        currentPath = file.startsWith("b/") ? file.slice(2) : file;
        if (!allowed.has(currentPath)) allowed.set(currentPath, new Set());
      }
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (!currentPath) {
        newLine = null;
        continue;
      }
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      newLine = match ? Number(match[1]) : null;
      continue;
    }

    if (!currentPath || newLine === null) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      allowed.get(currentPath).add(newLine);
      newLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      allowed.get(currentPath).add(newLine);
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) continue;
    if (line.startsWith("\\")) continue;

    newLine = null;
  }

  return allowed;
}

function normalizeComment(comment) {
  if (!comment || typeof comment !== "object") return null;

  const filePath = String(comment.path || "").trim();
  const bodyRaw = String(comment.body || "").trim();
  const line = Number(comment.line);
  if (!filePath || !bodyRaw || !Number.isInteger(line) || line <= 0) return null;

  let body = bodyRaw.length > 60000 ? `${bodyRaw.slice(0, 59950).trim()}\n\n[comment truncated]` : bodyRaw;
  const severity = String(comment.severity || "").trim().toLowerCase();
  if (["high", "medium", "low"].includes(severity)) {
    body = `**${severity}**: ${body}`;
  }

  return { path: filePath, line, body };
}

function assertOnlyKeys(value, allowed, pathName) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${pathName} contains unsupported field: ${key}`);
    }
  }
}

function validateReviewSchema(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    throw new Error("Agent output must be a JSON object");
  }
  assertOnlyKeys(review, ["summary", "comments"], "Agent output");

  if (typeof review.summary !== "string" || review.summary.length < 1 || review.summary.length > 12000) {
    throw new Error("Agent output summary must be a string between 1 and 12000 characters");
  }
  if (!Array.isArray(review.comments) || review.comments.length > 20) {
    throw new Error("Agent output comments must be an array with at most 20 comments");
  }

  for (const [index, comment] of review.comments.entries()) {
    if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
      throw new Error(`Agent output comments[${index}] must be an object`);
    }
    assertOnlyKeys(comment, ["path", "line", "body", "severity"], `Agent output comments[${index}]`);
    if (typeof comment.path !== "string" || comment.path.length < 1 || comment.path.length > 1000) {
      throw new Error(`Agent output comments[${index}].path must be a string between 1 and 1000 characters`);
    }
    if (!Number.isInteger(comment.line) || comment.line < 1) {
      throw new Error(`Agent output comments[${index}].line must be a positive integer`);
    }
    if (typeof comment.body !== "string" || comment.body.length < 1 || comment.body.length > 60000) {
      throw new Error(`Agent output comments[${index}].body must be a string between 1 and 60000 characters`);
    }
    if (comment.severity !== undefined && !["high", "medium", "low"].includes(comment.severity)) {
      throw new Error(`Agent output comments[${index}].severity must be high, medium, or low`);
    }
  }

  return review;
}

function filterAgentReview(diffText, review, maxComments) {
  const allowed = parseAllowedLines(diffText);
  const rawComments = Array.isArray(review.comments) ? review.comments : [];
  const filtered = [];
  const seen = new Set();
  let dropped = 0;

  for (const raw of rawComments) {
    const comment = normalizeComment(raw);
    if (!comment) {
      dropped += 1;
      continue;
    }

    const validLines = allowed.get(comment.path);
    const key = `${comment.path}:${comment.line}:${comment.body}`;
    if (!validLines || !validLines.has(comment.line) || seen.has(key)) {
      dropped += 1;
      continue;
    }

    seen.add(key);
    filtered.push(comment);
    if (filtered.length >= maxComments) break;
  }

  let summary = String(review.summary || "Otter Reviewer completed.").trim();
  if (dropped) {
    summary += `\n\nFiltered out ${dropped} agent comments that did not target valid RIGHT-side diff lines.`;
  }

  return {
    summary: summary || "Otter Reviewer completed.",
    comments: filtered,
  };
}

const filterCodexReview = filterAgentReview;

function getPullRequestContext(event) {
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);

  const pull = event.pull_request || {};
  return {
    owner,
    repo,
    repository,
    prNumber: env("OTTER_PR_NUMBER") || env("PR_NUMBER") || String(pull.number || event.inputs?.pr_number || ""),
    baseRef: env("OTTER_BASE_REF") || pull.base?.ref || "",
    baseSha: env("OTTER_BASE_SHA") || pull.base?.sha || "",
    headSha: env("OTTER_HEAD_SHA") || pull.head?.sha || env("GITHUB_SHA"),
  };
}

function extraInstructions(repoRoot) {
  const chunks = [];
  const configPath = path.join(repoRoot, ".otter-reviewer.md");
  if (fs.existsSync(configPath)) {
    chunks.push(`Repository instructions from .otter-reviewer.md:\n${fs.readFileSync(configPath, "utf8")}`);
  }

  const envInstructions = env("OTTER_REVIEW_INSTRUCTIONS");
  if (envInstructions) {
    chunks.push(`Workflow instructions:\n${envInstructions}`);
  }

  return chunks.join("\n\n");
}

function buildPrompt({ context, diffText, baseCommit, repoRoot, maxComments }) {
  const instructions = extraInstructions(repoRoot);
  return `You are Otter Reviewer, reviewing GitHub pull request #${context.prNumber} in ${context.repository}.

Return JSON that matches the provided schema exactly. Do not edit files. Do not include Markdown fences.

Review rules:
- Find only actionable correctness, security, data-loss, concurrency, API-contract, or test-risk issues.
- Prefer no comment over a speculative or stylistic comment.
- Use repository-relative paths exactly as shown in the diff.
- Each comment must target a RIGHT-side line number present in the diff hunk.
- Keep each body concise and explain the concrete risk plus the smallest useful fix.
- Return at most ${maxComments} comments.
- If there are no actionable findings, return {"summary":"No actionable findings.","comments":[]}.

${instructions ? `${instructions}\n\n` : ""}PR metadata:
- base_ref: ${context.baseRef}
- base_commit: ${baseCommit}
- head_commit: ${context.headSha}

Unified diff:
${diffText}`;
}

function replacePlaceholders(value, replacements) {
  let next = value;
  for (const [key, replacement] of Object.entries(replacements)) {
    next = next.split(`{${key}}`).join(String(replacement));
  }
  return next;
}

function safeAgentEnv(extraNames) {
  const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "CI"];
  const next = {};
  for (const name of allowed) {
    if (process.env[name] !== undefined) next[name] = process.env[name];
  }
  for (const rawName of extraNames) {
    const name = rawName.trim();
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name in OTTER_AGENT_ENV_PASS: ${name}`);
    }
    if (process.env[name] !== undefined) next[name] = process.env[name];
  }
  return next;
}

function sensitiveEnvValues() {
  const namePattern = /(TOKEN|SECRET|KEY|PASSWORD|PASS|PAT|AUTH|CREDENTIAL|PRIVATE)/i;
  const values = new Set();
  for (const [name, value] of Object.entries(process.env)) {
    if (!namePattern.test(name) || typeof value !== "string" || value.length < 8) continue;
    values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function redactText(text) {
  let next = String(text || "");
  for (const secret of sensitiveEnvValues()) {
    next = next.split(secret).join("[redacted]");
  }
  return next
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted-github-token]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[redacted-github-token]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]");
}

function truncateText(text, maxLength) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 22).trim()}\n\n[content truncated]`;
}

function redactReview(review) {
  return {
    summary: truncateText(redactText(review.summary), 12000),
    comments: review.comments.map((comment) => ({
      ...comment,
      body: truncateText(redactText(comment.body), 60000),
    })),
  };
}

function gitDir(repoRoot) {
  return path.resolve(repoRoot, capture("git", ["rev-parse", "--git-dir"], { cwd: repoRoot }));
}

function fileDigest(file) {
  if (!fs.existsSync(file)) return "";
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function unsetGitExtraHeaders(repoRoot) {
  const result = spawnSync("git", ["config", "--local", "--get-regexp", "^http\\..*\\.extraheader$"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout) return;

  for (const line of result.stdout.split(/\r?\n/)) {
    const key = line.trim().split(/\s+/)[0];
    if (key) {
      spawnSync("git", ["config", "--local", "--unset-all", key], { cwd: repoRoot, encoding: "utf8" });
    }
  }
}

function gitFetch(repoRoot, args) {
  const token = env("GITHUB_TOKEN");
  const authArgs = token
    ? [
        "-c",
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(
          `x-access-token:${token}`
        ).toString("base64")}`,
      ]
    : [];
  const result = spawnSync("git", [...authArgs, "fetch", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git fetch failed with exit ${result.status}\n${truncateForLog(result.stderr || result.stdout)}`);
  }
  if (result.stdout) process.stdout.write(truncateForLog(result.stdout));
  if (result.stderr) process.stderr.write(truncateForLog(result.stderr));
}

function runCodexAgent({ prompt, repoRoot, rawReviewPath, schemaPath, timeoutMs }) {
  const codexHome = env("OTTER_CODEX_HOME", env("CODEX_HOME", path.join(os.homedir(), ".codex")));
  const codexConfig = path.join(codexHome, "config.toml");
  if (!fs.existsSync(codexConfig)) {
    throw new Error(`Codex config not found at ${codexConfig}`);
  }

  const codexEnv = { ...safeAgentEnv([]), CODEX_HOME: codexHome };
  const codexArgs = [
    "exec",
    "--cd",
    repoRoot,
    "-c",
    'approval_policy="never"',
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--color",
    "never",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    rawReviewPath,
  ];

  const codexProfile = env("OTTER_CODEX_PROFILE");
  if (codexProfile) codexArgs.push("--profile", codexProfile);

  const codexModel = env("OTTER_CODEX_MODEL");
  if (codexModel) codexArgs.push("--model", codexModel);

  codexArgs.push("-");
  run("codex", codexArgs, { cwd: repoRoot, env: codexEnv, input: prompt, timeout: timeoutMs });
  return fs.readFileSync(rawReviewPath, "utf8");
}

function assertCleanWorktree(repoRoot, context = "after running custom agent") {
  const status = capture("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot });
  if (status) {
    throw new Error(`Git worktree is not clean ${context}; refusing to post review comments`);
  }
}

function runCustomAgent({ prompt, repoRoot, rawReviewPath, schemaPath, promptPath, maxComments, timeoutMs }) {
  const command = env("OTTER_AGENT_COMMAND");
  const args = parseJsonArrayEnv("OTTER_AGENT_ARGS_JSON", []);
  const envPass = env("OTTER_AGENT_ENV_PASS")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const replacements = {
    repoRoot,
    schemaPath,
    outputPath: rawReviewPath,
    promptPath,
    maxComments,
  };
  const resolvedArgs = args.map((arg) => replacePlaceholders(arg, replacements));
  const agentEnv = {
    ...safeAgentEnv(envPass),
    OTTER_AGENT_OUTPUT_PATH: rawReviewPath,
    OTTER_REVIEW_SCHEMA_PATH: schemaPath,
    OTTER_REVIEW_PROMPT_PATH: promptPath,
    OTTER_MAX_INLINE_COMMENTS: String(maxComments),
  };
  assertCleanWorktree(repoRoot, "before running custom agent");
  const gitConfigPath = path.join(gitDir(repoRoot), "config");
  const gitConfigBefore = fileDigest(gitConfigPath);
  const stdout = capture(command, resolvedArgs, {
    cwd: repoRoot,
    env: agentEnv,
    input: prompt,
    timeout: timeoutMs,
  });
  assertCleanWorktree(repoRoot);
  if (fileDigest(gitConfigPath) !== gitConfigBefore) {
    throw new Error("Custom agent modified git config; refusing to post review comments");
  }

  if (fs.existsSync(rawReviewPath) && fs.statSync(rawReviewPath).size > 0) {
    return fs.readFileSync(rawReviewPath, "utf8");
  }
  return stdout;
}

function runReviewAgent({ prompt, repoRoot, rawReviewPath, schemaPath, promptPath, maxComments }) {
  const timeoutMs = numberEnv("OTTER_AGENT_TIMEOUT_SECONDS", 900) * 1000;
  if (env("OTTER_AGENT_COMMAND")) {
    return runCustomAgent({ prompt, repoRoot, rawReviewPath, schemaPath, promptPath, maxComments, timeoutMs });
  }
  return runCodexAgent({ prompt, repoRoot, rawReviewPath, schemaPath, timeoutMs });
}

function payloadPath() {
  return requiredEnv("OTTER_REVIEW_PAYLOAD_PATH");
}

function writeSkipPayload(reason) {
  writeJson(payloadPath(), { skip: true, reason });
  console.log(reason);
}

function rejectForkPrIfNeeded(pr, context) {
  const headRepository = pr.head?.repo?.full_name || "";
  if (headRepository && headRepository !== context.repository && !boolEnv("OTTER_ALLOW_FORK_PRS", false)) {
    throw new Error(
      `Refusing to review fork PR #${context.prNumber} from ${headRepository}. ` +
        "Use allow-fork-prs only with an isolated runner and no sensitive agent credentials."
    );
  }
}

async function prepareReview() {
  const eventPath = env("GITHUB_EVENT_PATH");
  const event = eventPath && fs.existsSync(eventPath) ? readJson(eventPath) : {};
  const context = getPullRequestContext(event);
  if (!context.prNumber) {
    writeSkipPayload("No pull request number found; skipping Otter Reviewer.");
    return;
  }

  const apiUrl = env("GITHUB_API_URL", DEFAULT_API_URL);
  const githubToken = requiredEnv("GITHUB_TOKEN");
  const pr = await githubJson("GET", apiUrl, `/repos/${context.owner}/${context.repo}/pulls/${context.prNumber}`, githubToken);
  rejectForkPrIfNeeded(pr, context);

  if (pr.draft && !boolEnv("OTTER_REVIEW_DRAFTS", false)) {
    writeSkipPayload(`PR #${context.prNumber} is a draft; skipping Otter Reviewer.`);
    return;
  }

  context.baseRef = context.baseRef || pr.base.ref;
  context.baseSha = context.baseSha || pr.base.sha;
  context.headSha = pr.head.sha;

  const repoRoot = capture("git", ["rev-parse", "--show-toplevel"]);
  process.chdir(repoRoot);
  unsetGitExtraHeaders(repoRoot);

  gitFetch(repoRoot, ["--no-tags", "--prune", "origin", `+refs/heads/${context.baseRef}:refs/remotes/origin/${context.baseRef}`]);

  const currentHead = capture("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (currentHead !== context.headSha) {
    gitFetch(repoRoot, ["--no-tags", "origin", `+refs/pull/${context.prNumber}/head:refs/remotes/origin/pr/${context.prNumber}`]);
    run("git", ["checkout", "--detach", `refs/remotes/origin/pr/${context.prNumber}`], { cwd: repoRoot });
  }

  let baseCommit = capture("git", ["merge-base", `refs/remotes/origin/${context.baseRef}`, "HEAD"], { cwd: repoRoot });
  if (!baseCommit) baseCommit = context.baseSha || `refs/remotes/origin/${context.baseRef}`;

  const diffContext = env("OTTER_DIFF_CONTEXT", "80");
  const diffText = capture("git", ["diff", `--unified=${diffContext}`, "--find-renames", baseCommit, "HEAD"], { cwd: repoRoot });
  if (!diffText.trim()) {
    writeSkipPayload(`No diff found for PR #${context.prNumber}; skipping Otter Reviewer.`);
    return;
  }
  const maxDiffBytes = numberEnv("OTTER_MAX_DIFF_BYTES", 250000);
  if (Buffer.byteLength(diffText, "utf8") > maxDiffBytes) {
    throw new Error(`PR diff is too large for Otter Reviewer (${Buffer.byteLength(diffText, "utf8")} bytes > ${maxDiffBytes} bytes)`);
  }

  const maxComments = numberEnv("OTTER_MAX_INLINE_COMMENTS", 10);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-reviewer-"));
  const rawReviewPath = path.join(tempDir, "agent-review.raw.json");
  const promptPath = path.join(tempDir, "review-prompt.md");
  const schemaPath = path.join(ROOT, "schema", "review.schema.json");
  try {
    const prompt = buildPrompt({ context, diffText, baseCommit, repoRoot, maxComments });
    fs.writeFileSync(promptPath, prompt, { mode: 0o600 });

    const rawReview = validateReviewSchema(
      extractJson(runReviewAgent({ prompt, repoRoot, rawReviewPath, schemaPath, promptPath, maxComments }))
    );
    const review = redactReview(filterAgentReview(diffText, rawReview, maxComments));
    const runUrl =
      env("GITHUB_SERVER_URL") && env("GITHUB_RUN_ID")
        ? `${env("GITHUB_SERVER_URL")}/${context.repository}/actions/runs/${env("GITHUB_RUN_ID")}`
        : "";

    const body = ["Otter Reviewer", "", review.summary, runUrl ? `Run: ${runUrl}` : ""].filter(Boolean).join("\n");
    const payload = {
      commit_id: context.headSha,
      event: "COMMENT",
      body,
      comments: review.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: "RIGHT",
        body: comment.body,
      })),
    };

    if (payload.comments.length === 0 && !boolEnv("OTTER_POST_EMPTY_REVIEW", true)) {
      writeSkipPayload("Agent produced no valid inline comments.");
      return;
    }

    writeJson(payloadPath(), {
      skip: false,
      owner: context.owner,
      repo: context.repo,
      prNumber: context.prNumber,
      payload,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function postReview() {
  const prepared = readJson(payloadPath());
  if (prepared.skip) {
    console.log(prepared.reason || "Otter Reviewer skipped.");
    return;
  }

  if (boolEnv("OTTER_DRY_RUN", false)) {
    console.log(JSON.stringify(prepared.payload, null, 2));
    return;
  }

  const apiUrl = env("GITHUB_API_URL", DEFAULT_API_URL);
  const appToken = await createInstallationToken({ apiUrl, owner: prepared.owner, repo: prepared.repo });
  await githubJson(
    "POST",
    apiUrl,
    `/repos/${prepared.owner}/${prepared.repo}/pulls/${prepared.prNumber}/reviews`,
    appToken,
    prepared.payload
  );
  console.log(
    `Posted Otter Reviewer review for PR #${prepared.prNumber} with ${prepared.payload.comments.length} inline comments.`
  );
}

async function main() {
  const command = process.argv[2];
  if (command === "prepare") {
    await prepareReview();
    return;
  }
  if (command === "post") {
    await postReview();
    return;
  }

  if (command === "review") {
    console.error("The single-process review command is disabled; use prepare followed by post.");
    process.exit(2);
  }

  if (!["prepare", "post"].includes(command)) {
    console.error("Usage: otter-reviewer prepare|post");
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    if (error.cause) {
      console.error("Caused by:", error.cause.stack || error.cause.message || String(error.cause));
    }
    process.exit(1);
  });
}

module.exports = {
  parseAllowedLines,
  filterCodexReview,
  parseJsonArrayText,
  parseJsonArrayEnv,
  replacePlaceholders,
  safeAgentEnv,
  validateReviewSchema,
  normalizePrivateKey,
  createAppJwt,
};
