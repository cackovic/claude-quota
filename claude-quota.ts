#!/usr/bin/env -S npx tsx
/**
 * claude-quota.ts
 * ----------------
 * Reports the Claude Code subscription quota:
 *   - 5-hour session window (% used / % left + reset countdown)
 *   - 7-day weekly window  (% used / % left + reset)
 *   - per-model weekly windows (Opus / Sonnet) when present
 *   - extra-usage / overage credits
 *
 * It authorizes independently with Claude and stores its own OAuth credentials,
 * then calls the same private endpoint the CLI's `/usage` command uses:
 *     GET https://api.anthropic.com/api/oauth/usage
 *
 * If the stored access token is expired it transparently refreshes it via
 *     POST https://platform.claude.com/v1/oauth/token
 * and writes the rotated tokens back to its own credential store.
 *
 * Run:  npx tsx claude-quota.ts            (human-readable; logs in if needed)
 *       npx tsx claude-quota.ts --login    (authorize/re-authorize)
 *       npx tsx claude-quota.ts --json     (raw JSON)
 *
 * Requires Node 18+ (built-in fetch). Credentials use an app-specific file
 * under the XDG config directory on every platform.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

// ---- Constants (same endpoints Claude Code's /usage command uses) ----------
const USAGE_URL = process.env.CLAUDE_QUOTA_USAGE_URL
  ?? "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = process.env.CLAUDE_QUOTA_TOKEN_URL
  ?? "https://platform.claude.com/v1/oauth/token";
const AUTHORIZE_URL = process.env.CLAUDE_QUOTA_AUTHORIZE_URL
  ?? "https://claude.com/cai/oauth/authorize";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Code public OAuth client
const OAUTH_BETA = "oauth-2025-04-20";
const SCOPES = [
  "user:inference",
  "user:profile",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const USER_AGENT = "claude-cli/2.1.185 (external, cli)";
const REFRESH_SKEW_MS = 60_000; // refresh if it expires within a minute
const configuredTimeout = Number(process.env.CLAUDE_QUOTA_TIMEOUT_MS ?? "15000");
const REQUEST_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0
  ? configuredTimeout
  : 15_000;

class HttpResponseError extends Error {
  constructor(
    readonly context: string,
    readonly status: number,
    readonly retryAfter: string | null,
    detail: string,
  ) {
    const category = status === 429
      ? "rate limited"
      : status >= 500
      ? "service error"
      : "failed";
    const retry = retryAfter ? `; retry after ${retryAfter}` : "";
    super(`${context} ${category}: HTTP ${status}${retry}${detail ? `: ${detail}` : ""}`);
  }
}

async function request(
  context: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if ((err as { name?: string }).name === "TimeoutError") {
      throw new Error(`${context} timed out after ${REQUEST_TIMEOUT_MS}ms.`);
    }
    throw new Error(`${context} network failure: ${(err as Error).message}`);
  }
}

function responseDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // Fall through to a bounded plain-text detail.
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 300);
}

async function requireOk(context: string, response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = await response.text();
  throw new HttpResponseError(
    context,
    response.status,
    response.headers.get("retry-after"),
    responseDetail(body),
  );
}

async function parseJsonResponse(context: string, response: Response): Promise<unknown> {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${context} returned malformed JSON.`);
  }
}

// ---- Credential types -------------------------------------------------------
interface OAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}
interface CredBlob { claudeAiOauth: OAuth }

class InvalidCredentialsError extends Error {}

const configDir = process.env.CLAUDE_QUOTA_CONFIG_DIR
  ?? (process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "claude-quota")
    : join(homedir(), ".config", "claude-quota"));
const credPath = join(configDir, "credentials.json");
const lockPath = join(configDir, "credentials.lock");

// ---- Credential storage (read/write) ---------------------------------------
async function readCreds(): Promise<CredBlob> {
  await chmod(configDir, 0o700).catch((err: { code?: string }) => {
    if (err.code !== "ENOENT") throw err;
  });
  await chmod(credPath, 0o600).catch((err: { code?: string }) => {
    if (err.code !== "ENOENT") throw err;
  });
  let value: unknown;
  try {
    value = JSON.parse(await readFile(credPath, "utf8"));
  } catch (err) {
    const fileError = err as { code?: string };
    if (fileError.code === "ENOENT") throw err;
    throw new InvalidCredentialsError("Stored credentials are not valid JSON.");
  }
  if (!isCredBlob(value)) {
    throw new InvalidCredentialsError("Stored credentials have an invalid shape.");
  }
  return value;
}

function isCredBlob(value: unknown): value is CredBlob {
  if (!value || typeof value !== "object") return false;
  const oauth = (value as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return false;
  const candidate = oauth as Partial<OAuth>;
  return (
    typeof candidate.accessToken === "string" && candidate.accessToken.length > 0 &&
    typeof candidate.refreshToken === "string" && candidate.refreshToken.length > 0 &&
    typeof candidate.expiresAt === "number" && Number.isFinite(candidate.expiresAt) &&
    candidate.expiresAt > 0 &&
    Array.isArray(candidate.scopes) &&
    candidate.scopes.every((scope) => typeof scope === "string")
  );
}

async function writeCreds(blob: CredBlob): Promise<void> {
  const json = JSON.stringify(blob);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  const tempPath = join(
    configDir,
    `.credentials.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const file = await open(tempPath, "wx", 0o600);
  try {
    await file.writeFile(json, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(tempPath, credPath);
    await chmod(credPath, 0o600);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

async function withCredentialLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(String(process.pid), "utf8");
      await lock.close();
      try {
        return await fn();
      } finally {
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (err) {
      const conflict = err as { code?: string };
      if (conflict.code !== "EEXIST") throw err;
      try {
        const owner = Number.parseInt(await readFile(lockPath, "utf8"), 10);
        if (Number.isInteger(owner)) process.kill(owner, 0);
      } catch (ownerError) {
        const missingOwner = ownerError as { code?: string };
        if (missingOwner.code === "ESRCH") {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for the credential lock.");
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function authorize(): Promise<OAuth> {
  if (!process.stdin.isTTY) {
    throw new Error("Claude authorization requires an interactive terminal. Run claude-quota --login.");
  }

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();

  process.stderr.write("\nAuthorize claude-quota in Claude:\n\n");
  process.stderr.write(`${url.toString()}\n\n`);
  process.stderr.write("After approving, copy the code shown by Claude.\n");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const pasted = (await rl.question("Paste authorization code: ")).trim();
  rl.close();
  if (!pasted) throw new Error("No authorization code supplied.");

  // Claude may display either the code alone or `code#state`.
  const [code, returnedState] = pasted.split("#", 2);
  if (returnedState && returnedState !== state) {
    throw new Error("Authorization state mismatch; refusing to exchange the code.");
  }

  const res = await request("Authorization", TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-beta": OAUTH_BETA,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  await requireOk("Authorization", res);
  const t = (await parseJsonResponse("Authorization", res)) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
    subscription_type?: string;
    rate_limit_tier?: string;
  };
  if (
    typeof t.access_token !== "string" || !t.access_token ||
    typeof t.refresh_token !== "string" || !t.refresh_token ||
    typeof t.expires_in !== "number" || !Number.isFinite(t.expires_in) || t.expires_in <= 0
  ) {
    throw new Error("Authorization response did not include valid OAuth tokens and expiry.");
  }
  const oauth: OAuth = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    scopes: t.scope ? t.scope.split(" ") : SCOPES,
    subscriptionType: t.subscription_type,
    rateLimitTier: t.rate_limit_tier,
  };
  await writeCreds({ claudeAiOauth: oauth });
  process.stderr.write("Authorization saved for claude-quota.\n");
  return oauth;
}

// ---- OAuth refresh ----------------------------------------------------------
async function refresh(blob: CredBlob): Promise<OAuth> {
  const res = await request("Token refresh", TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-beta": OAUTH_BETA,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: blob.claudeAiOauth.refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  await requireOk("Token refresh", res);
  const t = (await parseJsonResponse("Token refresh", res)) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number; // seconds
    scope?: string;
  };
  if (
    typeof t.access_token !== "string" || !t.access_token ||
    typeof t.expires_in !== "number" || !Number.isFinite(t.expires_in) || t.expires_in <= 0 ||
    (t.refresh_token !== undefined && typeof t.refresh_token !== "string")
  ) {
    throw new Error("Token refresh response did not include a valid access token and expiry.");
  }
  const updated: OAuth = {
    ...blob.claudeAiOauth,
    accessToken: t.access_token,
    // The endpoint rotates the refresh token; fall back to the old one if not returned.
    refreshToken: t.refresh_token ?? blob.claudeAiOauth.refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000,
    scopes: t.scope ? t.scope.split(" ") : blob.claudeAiOauth.scopes,
  };
  await writeCreds({ claudeAiOauth: updated });
  return updated;
}

async function getValidToken(forceLogin = false): Promise<OAuth> {
  if (forceLogin) return authorize();
  let blob: CredBlob;
  try {
    blob = await readCreds();
  } catch (err) {
    const missing = err as { code?: string };
    if (missing.code !== "ENOENT" && !(err instanceof InvalidCredentialsError)) throw err;
    if (err instanceof InvalidCredentialsError) {
      process.stderr.write(`• ${err.message} Authorizing again…\n`);
    }
    return authorize();
  }
  const oauth = blob.claudeAiOauth;
  if (!oauth?.accessToken || !oauth.refreshToken) return authorize();
  if (Date.now() >= oauth.expiresAt - REFRESH_SKEW_MS) {
    process.stderr.write("• access token expired — refreshing…\n");
    return refresh(blob);
  }
  return oauth;
}

// ---- Usage endpoint ---------------------------------------------------------
interface Window {
  utilization: number; // % used 0..100
  resets_at: string | null; // ISO 8601
  limit_dollars: number | null;
  used_dollars: number | null;
  remaining_dollars: number | null;
}
interface UsageResponse {
  five_hour: Window | null;
  seven_day: Window | null;
  seven_day_opus: Window | null;
  seven_day_sonnet: Window | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number;
    currency: string;
    disabled_reason?: string | null;
  } | null;
  limits?: Array<{
    kind: string;
    group: string;
    percent: number;
    severity: string;
    resets_at: string | null;
    is_active: boolean;
  }>;
  [k: string]: unknown;
}

function isUsageWindow(value: unknown): value is Window | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Window>;
  return (
    typeof candidate.utilization === "number" && Number.isFinite(candidate.utilization) &&
    (candidate.resets_at === null || typeof candidate.resets_at === "string")
  );
}

function parseUsage(value: unknown): UsageResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Usage response has an invalid shape.");
  }
  const usage = value as Partial<UsageResponse>;
  if (
    !("five_hour" in usage) || !isUsageWindow(usage.five_hour) ||
    !("seven_day" in usage) || !isUsageWindow(usage.seven_day) ||
    !("seven_day_opus" in usage) || !isUsageWindow(usage.seven_day_opus) ||
    !("seven_day_sonnet" in usage) || !isUsageWindow(usage.seven_day_sonnet) ||
    !isExtraUsage(usage.extra_usage)
  ) {
    throw new Error("Usage response has an invalid shape.");
  }
  return usage as UsageResponse;
}

function isExtraUsage(value: UsageResponse["extra_usage"] | unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  const candidate = value as NonNullable<UsageResponse["extra_usage"]>;
  return (
    typeof candidate.is_enabled === "boolean" &&
    typeof candidate.monthly_limit === "number" && Number.isFinite(candidate.monthly_limit) &&
    typeof candidate.used_credits === "number" && Number.isFinite(candidate.used_credits) &&
    typeof candidate.utilization === "number" && Number.isFinite(candidate.utilization) &&
    typeof candidate.currency === "string"
  );
}

async function fetchUsage(token: string): Promise<UsageResponse> {
  const res = await request("Usage request", USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "anthropic-beta": OAUTH_BETA,
      "User-Agent": USER_AGENT,
    },
  });
  await requireOk("Usage request", res);
  return parseUsage(await parseJsonResponse("Usage request", res));
}

// ---- Formatting -------------------------------------------------------------
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function countdown(iso: string | null): string {
  if (!iso) return "n/a";
  const resetAt = Date.parse(iso);
  if (!Number.isFinite(resetAt)) return "n/a";
  const ms = resetAt - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function localTime(): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date()).toLowerCase();
}

function bar(pctUsed: number, width = 20): string {
  const filled = Math.round((clampPercent(pctUsed) / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function line(label: string, w: Window | null): string {
  if (!w) return `${label.padEnd(16)} (not active)`;
  const used = clampPercent(w.utilization);
  const left = 100 - used;
  return (
    `${label.padEnd(16)} ${bar(used)}  ${left.toFixed(0).padStart(3)}% left` +
    `  (used ${used.toFixed(0)}%)  resets in ${countdown(w.resets_at)}`
  );
}

// ---- Main -------------------------------------------------------------------
interface Options {
  forceLogin: boolean;
  help: boolean;
  mode: "full" | "short" | "json";
}

function parseOptions(args: string[]): Options {
  let forceLogin = false;
  let help = false;
  let mode: Options["mode"] = "full";
  let selectedMode: Options["mode"] | undefined;
  for (const arg of args) {
    if (arg === "--login") forceLogin = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--json") selectedMode = selectMode(selectedMode, "json");
    else if (arg === "--short" || arg === "-s") selectedMode = selectMode(selectedMode, "short");
    else if (arg === "full") selectedMode = selectMode(selectedMode, "full");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (selectedMode) mode = selectedMode;
  return { forceLogin, help, mode };
}

function selectMode(current: Options["mode"] | undefined, next: Options["mode"]): Options["mode"] {
  if (current && current !== next) {
    throw new Error(`Output modes cannot be combined: ${current} and ${next}`);
  }
  return next;
}

function printHelp(): void {
  console.log(`Usage: claude-quota [--login] [--short | --json]

Options:
  --login       Authorize again before requesting quota
  --short, -s   Print a compact one-line summary
  --json        Print the validated API response as JSON
  --help, -h    Show this help`);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  let oauth = await withCredentialLock(() =>
    getValidToken(options.forceLogin),
  );
  let usage: UsageResponse;
  try {
    usage = await fetchUsage(oauth.accessToken);
  } catch (err) {
    if (!(err instanceof HttpResponseError) || err.context !== "Usage request" || err.status !== 401) {
      throw err;
    }
    process.stderr.write("• access token rejected — refreshing and retrying once…\n");
    oauth = await withCredentialLock(async () => {
      try {
        return await refresh(await readCreds());
      } catch (refreshError) {
        process.stderr.write(
          `• refresh failed (${(refreshError as Error).message}) — authorizing again…\n`,
        );
        return authorize();
      }
    });
    usage = await fetchUsage(oauth.accessToken);
  }

  if (options.mode === "json") {
    console.log(JSON.stringify(usage, null, 2));
    return;
  }

  if (options.mode === "short") {
    const parts: string[] = [];
    if (usage.five_hour) {
      parts.push(
        `5h:${Math.floor(100 - clampPercent(usage.five_hour.utilization))}% left ` +
          `(${countdown(usage.five_hour.resets_at).replaceAll(" ", "")})`,
      );
    }
    if (usage.seven_day) {
      parts.push(
        `7d:${Math.floor(100 - clampPercent(usage.seven_day.utilization))}% left ` +
          `(${countdown(usage.seven_day.resets_at).replaceAll(" ", "")})`,
      );
    }
    parts.push(`now ${localTime()}`);
    console.log(parts.join("  ·  "));
    return;
  }

  console.log("\n  Claude Code quota");
  console.log(`  Current Time: ${localTime()}`);
  console.log(`  plan: ${oauth.subscriptionType ?? "?"} (${oauth.rateLimitTier ?? "?"})`);
  console.log("  " + "─".repeat(70));
  console.log("  " + line("5-hour session", usage.five_hour));
  console.log("  " + line("7-day (all)", usage.seven_day));
  if (usage.seven_day_opus) console.log("  " + line("7-day Opus", usage.seven_day_opus));
  if (usage.seven_day_sonnet) console.log("  " + line("7-day Sonnet", usage.seven_day_sonnet));

  const ex = usage.extra_usage;
  if (ex && ex.monthly_limit > 0) {
    const utilization = clampPercent(ex.utilization);
    const left = 100 - utilization;
    console.log("  " + "─".repeat(70));
    console.log(
      `  extra usage      ${bar(utilization)}  ${left.toFixed(0).padStart(3)}% left` +
        `  (${ex.used_credits.toFixed(0)}/${ex.monthly_limit} ${ex.currency}` +
        `${ex.is_enabled ? "" : ", disabled: " + (ex.disabled_reason ?? "n/a")})`,
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
