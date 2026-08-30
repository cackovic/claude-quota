import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const cliPath = resolve("claude-quota.ts");
const usagePayload = {
  five_hour: { utilization: 25, resets_at: null },
  seven_day: { utilization: 50, resets_at: null },
  seven_day_opus: null,
  seven_day_sonnet: null,
};

async function tempConfig() {
  return mkdtemp(join(tmpdir(), "claude-quota-test-"));
}

async function writeCredentials(configDir, overrides = {}) {
  await mkdir(configDir, { recursive: true });
  const credentials = {
    claudeAiOauth: {
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:profile"],
      ...overrides,
    },
  };
  await writeFile(join(configDir, "credentials.json"), JSON.stringify(credentials));
  return credentials;
}

async function mockApi(handler) {
  const server = createServer(handler);
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function runCli(configDir, baseUrl, args = [], env = {}) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", cliPath, ...args],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        CLAUDE_QUOTA_CONFIG_DIR: configDir,
        CLAUDE_QUOTA_USAGE_URL: `${baseUrl}/usage`,
        CLAUDE_QUOTA_TOKEN_URL: `${baseUrl}/token`,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolvePromise) => child.on("close", resolvePromise));
  return { code, stdout, stderr };
}

test("reuses persisted credentials across launches", async (t) => {
  const configDir = await tempConfig();
  await writeCredentials(configDir);
  let usageCalls = 0;
  const api = await mockApi((request, response) => {
    if (request.url === "/usage") {
      usageCalls++;
      json(response, 200, usagePayload);
    }
  });
  t.after(api.close);

  const first = await runCli(configDir, api.baseUrl, ["--short"]);
  const second = await runCli(configDir, api.baseUrl, ["--short"]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /5h:75% left/);
  assert.equal(usageCalls, 2);
});

test("refreshes rotating tokens and persists private permissions", async (t) => {
  const configDir = await tempConfig();
  await writeCredentials(configDir, { expiresAt: Date.now() - 1 });
  await chmod(configDir, 0o755);
  await chmod(join(configDir, "credentials.json"), 0o644);
  let refreshCalls = 0;
  const api = await mockApi((request, response) => {
    if (request.url === "/token") {
      refreshCalls++;
      json(response, 200, {
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
      });
    } else if (request.url === "/usage") {
      assert.equal(request.headers.authorization, "Bearer access-new");
      json(response, 200, usagePayload);
    }
  });
  t.after(api.close);

  const result = await runCli(configDir, api.baseUrl, ["--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(refreshCalls, 1);
  const saved = JSON.parse(await readFile(join(configDir, "credentials.json"), "utf8"));
  assert.equal(saved.claudeAiOauth.refreshToken, "refresh-new");
  assert.equal((await stat(configDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(configDir, "credentials.json"))).mode & 0o777, 0o600);
});

test("refreshes and retries exactly once after a usage 401", async (t) => {
  const configDir = await tempConfig();
  await writeCredentials(configDir);
  let usageCalls = 0;
  let refreshCalls = 0;
  const api = await mockApi((request, response) => {
    if (request.url === "/token") {
      refreshCalls++;
      json(response, 200, { access_token: "access-new", expires_in: 3600 });
    } else if (request.url === "/usage") {
      usageCalls++;
      if (request.headers.authorization === "Bearer access-old") {
        json(response, 401, { error: { message: "expired" } });
      } else {
        json(response, 200, usagePayload);
      }
    }
  });
  t.after(api.close);

  const result = await runCli(configDir, api.baseUrl, ["--short"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(usageCalls, 2);
  assert.equal(refreshCalls, 1);
});

test("serializes concurrent refreshes", async (t) => {
  const configDir = await tempConfig();
  await writeCredentials(configDir, { expiresAt: Date.now() - 1 });
  let refreshCalls = 0;
  const api = await mockApi((request, response) => {
    if (request.url === "/token") {
      refreshCalls++;
      setTimeout(() => json(response, 200, {
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
      }), 100);
    } else if (request.url === "/usage") {
      json(response, 200, usagePayload);
    }
  });
  t.after(api.close);

  const [first, second] = await Promise.all([
    runCli(configDir, api.baseUrl, ["--short"]),
    runCli(configDir, api.baseUrl, ["--short"]),
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(refreshCalls, 1);
});

test("rejects malformed stored credentials before making requests", async () => {
  const configDir = await tempConfig();
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "credentials.json"), "not-json");
  const result = await runCli(configDir, "http://127.0.0.1:1");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Stored credentials are not valid JSON/);
  assert.match(result.stderr, /requires an interactive terminal/);
});

test("rejects unknown and conflicting arguments before reading credentials", async () => {
  const configDir = await tempConfig();
  const unknown = await runCli(configDir, "http://127.0.0.1:1", ["--bogus"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown argument: --bogus/);
  assert.doesNotMatch(unknown.stderr, /authorization requires/);

  const conflicting = await runCli(configDir, "http://127.0.0.1:1", ["--short", "--json"]);
  assert.equal(conflicting.code, 1);
  assert.match(conflicting.stderr, /Output modes cannot be combined/);
});

test("reports rate limits with retry guidance", async (t) => {
  const configDir = await tempConfig();
  await writeCredentials(configDir);
  const api = await mockApi((request, response) => {
    if (request.url === "/usage") {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "12" });
      response.end(JSON.stringify({ error: { message: "slow down" } }));
    }
  });
  t.after(api.close);

  const result = await runCli(configDir, api.baseUrl, ["--short"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage request rate limited: HTTP 429; retry after 12: slow down/);
});

test("times out stalled usage requests", async (t) => {
  const configDir = await tempConfig();
  await writeCredentials(configDir);
  const api = await mockApi(() => {});
  t.after(api.close);

  const result = await runCli(
    configDir,
    api.baseUrl,
    ["--short"],
    { CLAUDE_QUOTA_TIMEOUT_MS: "50" },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage request timed out after 50ms/);
});

test("validates usage responses and clamps formatting", async (t) => {
  const configDir = await tempConfig();
  await writeCredentials(configDir);
  let validShape = false;
  const api = await mockApi((request, response) => {
    if (request.url !== "/usage") return;
    if (!validShape) {
      json(response, 200, { five_hour: { utilization: "25", resets_at: null } });
      return;
    }
    json(response, 200, {
      ...usagePayload,
      five_hour: { utilization: -5, resets_at: "not-a-date" },
      seven_day: { utilization: 140, resets_at: null },
    });
  });
  t.after(api.close);

  const invalid = await runCli(configDir, api.baseUrl, ["--short"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Usage response has an invalid shape/);

  validShape = true;
  const clamped = await runCli(configDir, api.baseUrl, ["--short"]);
  assert.equal(clamped.code, 0, clamped.stderr);
  assert.match(clamped.stdout, /5h:100% left \(n\/a\)/);
  assert.match(clamped.stdout, /7d:0% left/);
});
