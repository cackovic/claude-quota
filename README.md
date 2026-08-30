# Claude Code Quota Checker

A tiny CLI that reports your **Claude Code** subscription limits — the
**5-hour session** window and the **7-day weekly** window — as a percentage
left, with reset countdowns. Plus per-model weekly windows and pay-as-you-go
overage credits.

```
  Claude Code quota
  Current Time: 11:07 pm
  ──────────────────────────────────────────────────────────────────────
  5-hour session   ███░░░░░░░░░░░░░░░░░   83% left  (used 17%)  resets in 2h 21m
  7-day (all)      ███░░░░░░░░░░░░░░░░░   85% left  (used 15%)  resets in 82h 31m
  7-day Sonnet     ░░░░░░░░░░░░░░░░░░░░  100% left  (used 0%)  resets in n/a
  ──────────────────────────────────────────────────────────────────────
  extra usage      ░░░░░░░░░░░░░░░░░░░░  100% left  (0/15000 USD, disabled: ...)
```

## Inspiration

This started from wanting a **`/goal`-style loop** for Claude Code: a task that
keeps running *as long as there is quota left*, and **waits/backs off** when a
limit is approaching.

For a lot of work there is no natural "done" — a **software-factory** model that
keeps shipping units, or an **open-ended optimization** task that can always try
one more iteration. The only real stopping condition isn't *task completion*,
it's the **rate limit**. So the agent needs to ask: *do I have enough budget for
one more loop, or should I pause until the window resets?*

That's exactly what this tool answers. Claude Code (or any orchestrator) can call
it between iterations to decide:

```bash
# crude gate: keep looping while >10% of the 5-hour window remains
while [ "$(claude-quota --short | grep -oE '5h:[0-9]+' | grep -oE '[0-9]+')" -gt 10 ]; do
  run_one_unit_of_work
done
# …otherwise sleep until the window resets (see `resets in …` / --json resets_at)
```

The `--short` and `--json` modes exist precisely so an agent can read the numbers
programmatically and decide **continue / wait / stop** without a human in the loop.

## What it shows

| Window | Field | Meaning |
|---|---|---|
| 5-hour session | `five_hour` | rolling 5-hour usage window |
| 7-day weekly | `seven_day` | weekly usage window |
| 7-day per model | `seven_day_opus`, `seven_day_sonnet` | model-scoped weekly windows |
| overage | `extra_usage` / `spend` | optional pay-as-you-go credits |

Each window reports **% used**, **% left** (`100 − used`), and **when it resets**.

## Install

```bash
git clone https://github.com/yehjxraymond/claude-quota
cd claude-quota
chmod +x claude-quota.sh
npm install
# optional: put it on your PATH
ln -s "$PWD/claude-quota.sh" ~/.local/bin/claude-quota
```

Dependencies: Node.js 18+ and npm.

## Usage

```bash
claude-quota --login    # authorize this app with Claude (also happens on first run)
claude-quota            # full readable report
claude-quota --short    # one line: 5h:83% left (2h21m)  ·  7d:85% left (3d10h)  ·  now 11:07 pm
claude-quota --json     # raw API payload (for scripting)
claude-quota --help     # show all supported arguments
```

`claude-quota.ts` is the canonical implementation. `claude-quota.sh` is a small
compatibility launcher that resolves the local `tsx` dependency and forwards all
arguments, so both entry points always have identical behavior.

Works on macOS and Linux/WSL. Authorization requires an interactive terminal
once; subsequent quota checks and token refreshes are non-interactive.
Network requests time out after 15 seconds by default. Set
`CLAUDE_QUOTA_TIMEOUT_MS` to a positive millisecond value to override it.

---

## How it works

Claude Code's own `/usage` command (aliases `/cost`, `/stats`) reads your
subscription limits from an internal endpoint. This tool calls the same one,
but performs its own OAuth authorization-code flow with PKCE and maintains a
separate credential. It never reads or changes Claude Code's stored token.

On first run, the CLI prints a Claude authorization URL. Open it, approve access,
then paste the code shown by Claude back into the terminal. Use `--login` at any
time to authorize again or switch accounts.

The pasted value must be the one-time authorization code shown after browser
approval (sometimes formatted as `code#state`), not an `sk-ant-api...` Console
API key. If stored credentials are malformed or their refresh token is rejected,
the CLI automatically starts this authorization flow again.

### The endpoint

| | |
|---|---|
| **Method / URL** | `GET https://api.anthropic.com/api/oauth/usage` |
| **Auth** | `Authorization: Bearer <access_token>` |
| **Headers** | `anthropic-beta: oauth-2025-04-20`, `Content-Type: application/json` |

### Response shape

```jsonc
{
  "five_hour": {                 // the 5-hour session window
    "utilization": 17.0,         // PERCENT USED (0–100); "% left" = 100 - this
    "resets_at": "2026-06-21T15:50:00+00:00",  // ISO 8601 — when it resets
    "limit_dollars": null, "used_dollars": null, "remaining_dollars": null
  },
  "seven_day": { "utilization": 15.0, "resets_at": "2026-06-25T00:00:00+00:00", ... },
  "seven_day_opus":   null,      // per-model weekly window (null if N/A)
  "seven_day_sonnet": { "utilization": 0.0, "resets_at": null, ... },
  "extra_usage": {               // pay-as-you-go overage credits
    "is_enabled": false, "monthly_limit": 15000, "used_credits": 0,
    "utilization": 0, "currency": "USD", "disabled_reason": "out_of_credits"
  },
  "limits": [                    // flattened convenience view
    { "kind": "session",      "group": "session", "percent": 16, "severity": "normal",
      "resets_at": "...", "is_active": true },
    { "kind": "weekly_all",   "group": "weekly",  "percent": 15, "severity": "normal", ... },
    { "kind": "weekly_scoped","group": "weekly",  "percent": 0,  "scope": {"model": {"display_name": "Sonnet"}}, ... }
  ],
  "spend": { "used": {...}, "limit": {...}, "percent": 98, "severity": "critical", ... }
}
```

Key points:
- **`utilization` is percent _used_.** Percent **left = `100 - utilization`**.
- **5-hour quota** → `five_hour`. **Weekly quota** → `seven_day`.
- **Time to reset** → `resets_at` (ISO 8601). Subtract `now` for the countdown.
- `severity` escalates `normal` → `warning` → `critical` as you approach a limit.
- `extra_usage` / `spend` describe the optional paid overage pool, not the
  subscription windows.

### Authorizing / refreshing the token

The tool uses **OAuth 2.0 authorization code with PKCE**. It generates a new
verifier, challenge, and state for each login, then exchanges the one-time code
for its own access and refresh tokens. The access token is short-lived and is
refreshed automatically.

**Where it's stored**
- **All platforms:** `${XDG_CONFIG_HOME:-~/.config}/claude-quota/credentials.json`
  with mode `0600` in a mode-`0700` directory. Set
  `CLAUDE_QUOTA_CONFIG_DIR` to override the directory.

The credential JSON:
```jsonc
{
  "claudeAiOauth": {
    "accessToken":  "sk-ant-oat01-…",   // bearer for the usage endpoint
    "refreshToken": "sk-ant-ort01-…",   // used to mint a new access token
    "expiresAt":    1782059384339,       // unix MILLIS — when accessToken dies
    "scopes":       ["user:inference", "user:profile", ...],
    "subscriptionType": "max",
    "rateLimitTier":    "default_claude_max_5x"
  },
}
```

**Refreshing** (when `Date.now() >= expiresAt`):
```
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json
anthropic-beta: oauth-2025-04-20

{ "grant_type": "refresh_token",
  "refresh_token": "sk-ant-ort01-…",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e" }
```
Response: `{ access_token, refresh_token, expires_in (seconds), scope }`.

- `client_id` `9d1c250a-e61b-44d9-88ed-5944d1962f5e` is Claude Code's public
  OAuth client.
- The refresh **rotates the refresh token** — the tool writes the new
  `access_token` + `refresh_token` + recomputed `expiresAt` back to its own
  app-specific config file. Claude Code's credential is untouched.
- The refresh endpoint is **rate-limited**; the tool refreshes lazily, only near
  expiry (60s skew).

---

## Reference

| Item | Value |
|---|---|
| Usage endpoint | `GET https://api.anthropic.com/api/oauth/usage` |
| Token refresh | `POST https://platform.claude.com/v1/oauth/token` |
| OAuth authorize | `https://claude.com/cai/oauth/authorize` |
| OAuth client_id | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| Beta header | `anthropic-beta: oauth-2025-04-20` |
| Redirect URI | `https://platform.claude.com/oauth/code/callback` |
| Credential file | `${XDG_CONFIG_HOME:-~/.config}/claude-quota/credentials.json` |
| 5-hour quota field | `five_hour.utilization` (% used), `five_hour.resets_at` |
| Weekly quota field | `seven_day.utilization` (% used), `seven_day.resets_at` |
| % left | `100 - utilization` |

## Caveats

- This uses an **internal, undocumented endpoint** — Anthropic can change it
  without notice and it may stop working.
- The authorization flow uses Claude Code's public OAuth client identifier;
  Anthropic does not document this as a supported third-party integration.
- The Claude Code-compatible user agent is a deliberate protocol compatibility
  decision; see [Compatibility decisions](docs/compatibility-decisions.md).
- Use only with your own account/credentials.
- The endpoint reflects subscription rate-limit windows; the dollar/overage
  fields apply only if you've enabled pay-as-you-go usage.
