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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

// ---- Constants (same endpoints Claude Code's /usage command uses) ----------
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
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

const configDir = process.env.CLAUDE_QUOTA_CONFIG_DIR
  ?? (process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "claude-quota")
    : join(homedir(), ".config", "claude-quota"));
const credPath = join(configDir, "credentials.json");

// ---- Credential storage (read/write) ---------------------------------------
async function readCreds(): Promise<CredBlob> {
  return JSON.parse(await readFile(credPath, "utf8"));
}

async function writeCreds(blob: CredBlob): Promise<void> {
  const json = JSON.stringify(blob);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(credPath, json, { mode: 0o600 });
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

  const res = await fetch(TOKEN_URL, {
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
  if (!res.ok) {
    throw new Error(`Authorization failed: HTTP ${res.status} ${await res.text()}`);
  }
  const t = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
    subscription_type?: string;
    rate_limit_tier?: string;
  };
  if (!t.access_token || !t.refresh_token) {
    throw new Error("Authorization response did not include access and refresh tokens.");
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
  const res = await fetch(TOKEN_URL, {
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
  if (!res.ok) {
    throw new Error(
      `Token refresh failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
  const t = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number; // seconds
    scope?: string;
  };
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
    if (missing.code !== "ENOENT") throw err;
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

async function fetchUsage(token: string): Promise<UsageResponse> {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "anthropic-beta": OAUTH_BETA,
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    throw new Error(`Usage fetch failed: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ---- Formatting -------------------------------------------------------------
function countdown(iso: string | null): string {
  if (!iso) return "n/a";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function bar(pctUsed: number, width = 20): string {
  const filled = Math.round((pctUsed / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function line(label: string, w: Window | null): string {
  if (!w) return `${label.padEnd(16)} (not active)`;
  const used = w.utilization;
  const left = Math.max(0, 100 - used);
  return (
    `${label.padEnd(16)} ${bar(used)}  ${left.toFixed(0).padStart(3)}% left` +
    `  (used ${used.toFixed(0)}%)  resets in ${countdown(w.resets_at)}`
  );
}

// ---- Main -------------------------------------------------------------------
async function main() {
  const wantJson = process.argv.includes("--json");
  const oauth = await getValidToken(process.argv.includes("--login"));
  const usage = await fetchUsage(oauth.accessToken);

  if (wantJson) {
    console.log(JSON.stringify(usage, null, 2));
    return;
  }

  console.log("\n  Claude Code quota");
  console.log(`  plan: ${oauth.subscriptionType ?? "?"} (${oauth.rateLimitTier ?? "?"})`);
  console.log("  " + "─".repeat(70));
  console.log("  " + line("5-hour session", usage.five_hour));
  console.log("  " + line("7-day (all)", usage.seven_day));
  if (usage.seven_day_opus) console.log("  " + line("7-day Opus", usage.seven_day_opus));
  if (usage.seven_day_sonnet) console.log("  " + line("7-day Sonnet", usage.seven_day_sonnet));

  const ex = usage.extra_usage;
  if (ex && ex.monthly_limit > 0) {
    const left = Math.max(0, 100 - ex.utilization);
    console.log("  " + "─".repeat(70));
    console.log(
      `  extra usage      ${bar(ex.utilization)}  ${left.toFixed(0).padStart(3)}% left` +
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
