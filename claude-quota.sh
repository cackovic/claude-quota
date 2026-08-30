#!/usr/bin/env bash
#
# claude-quota.sh — show Claude Code subscription quota (5-hour + weekly).
#
#   claude-quota.sh            full readable report
#   claude-quota.sh --short    one line: 5h:83% (2h21m)  7d:85% (3d10h)
#   claude-quota.sh --json     raw API JSON
#
# Authorizes independently with Claude, stores an app-specific OAuth token,
# refreshes it if expired, and calls the same private endpoint the CLI's /usage
# command uses.
#
# Deps: curl, jq, openssl.

set -euo pipefail

USAGE_URL="https://api.anthropic.com/api/oauth/usage"
TOKEN_URL="https://platform.claude.com/v1/oauth/token"
AUTHORIZE_URL="https://claude.com/cai/oauth/authorize"
REDIRECT_URI="https://platform.claude.com/oauth/code/callback"
CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
OAUTH_BETA="oauth-2025-04-20"
SCOPES="user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload"
UA="claude-cli/2.1.185 (external, cli)"
CONFIG_DIR="${CLAUDE_QUOTA_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-quota}"
CRED_FILE="$CONFIG_DIR/credentials.json"
LOCK_DIR="$CONFIG_DIR/credentials.lock"
REFRESH_SKEW_MS=60000   # refresh if it expires within a minute

die() { echo "Error: $*" >&2; exit 1; }
command -v jq   >/dev/null || die "jq not found"
command -v curl >/dev/null || die "curl not found"
command -v openssl >/dev/null || die "openssl not found"

mode="${1:-full}"
case "$mode" in
  full|""|--short|-s|--json|--login) ;;
  *) die "unknown option: $mode (use --login, --short, --json, or no arg)" ;;
esac

# ---- credential read/write -------------------------------------------------
read_blob() {
  [[ -f "$CRED_FILE" ]] || return 1
  cat "$CRED_FILE"
}

acquire_lock() {
  local attempt owner
  mkdir -p -m 700 "$CONFIG_DIR"
  for (( attempt=0; attempt<100; attempt++ )); do
    if mkdir -m 700 "$LOCK_DIR" 2>/dev/null; then
      printf '%s' "$$" > "$LOCK_DIR/pid"
      return
    fi
    if [[ -r "$LOCK_DIR/pid" ]]; then
      IFS= read -r owner < "$LOCK_DIR/pid" || owner=""
      if [[ "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
        rm -f "$LOCK_DIR/pid"
        rmdir "$LOCK_DIR" 2>/dev/null || true
        continue
      fi
    fi
    sleep 0.1
  done
  die "timed out waiting for the credential lock"
}

release_lock() {
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

write_blob() {  # $1 = full JSON blob
  local temp_file
  mkdir -p -m 700 "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  umask 177
  temp_file="$(mktemp "$CONFIG_DIR/.credentials.json.XXXXXX")"
  printf '%s' "$1" > "$temp_file"
  chmod 600 "$temp_file"
  mv -f "$temp_file" "$CRED_FILE"
}

# ---- independent OAuth authorization (authorization code + PKCE) ----------
authorize() {
  [[ -t 0 || -r /dev/tty ]] || die "authorization requires an interactive terminal"

  local verifier challenge state query auth_url pasted code returned_state
  local resp token_json access refresh expires_in expires_at scope blob now_ms reason
  verifier="$(openssl rand 32 | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  challenge="$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  state="$(openssl rand 32 | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  query="$(jq -rn \
    --arg cid "$CLIENT_ID" --arg redirect "$REDIRECT_URI" --arg scopes "$SCOPES" \
    --arg challenge "$challenge" --arg state "$state" \
    '"code=true&client_id=\($cid|@uri)&response_type=code&redirect_uri=\($redirect|@uri)&scope=\($scopes|@uri)&code_challenge=\($challenge|@uri)&code_challenge_method=S256&state=\($state|@uri)"')" \
    || die "could not construct authorization URL"
  auth_url="$AUTHORIZE_URL?$query"

  printf '\nAuthorize claude-quota in Claude:\n\n%s\n\n' "$auth_url" >&2
  printf 'After approving, copy the code shown by Claude.\n' >&2
  printf 'Paste authorization code: ' >&2
  IFS= read -r pasted </dev/tty
  [[ -n "$pasted" ]] || die "no authorization code supplied"
  code="${pasted%%#*}"
  returned_state=""
  [[ "$pasted" == *#* ]] && returned_state="${pasted#*#}"
  [[ -z "$returned_state" || "$returned_state" == "$state" ]] \
    || die "authorization state mismatch; refusing to exchange the code"

  resp="$(curl -sS -X POST "$TOKEN_URL" \
    -H "Content-Type: application/json" \
    -H "anthropic-beta: $OAUTH_BETA" \
    -H "User-Agent: $UA" \
    -d "$(jq -n --arg code "$code" --arg state "$state" --arg cid "$CLIENT_ID" \
      --arg redirect "$REDIRECT_URI" --arg verifier "$verifier" \
      '{grant_type:"authorization_code",code:$code,state:$state,client_id:$cid,redirect_uri:$redirect,code_verifier:$verifier}')")" \
    || die "authorization request failed"
  if ! token_json="$(jq -ce '
      select((.access_token | type) == "string" and (.access_token | length) > 0)
      | select((.refresh_token | type) == "string" and (.refresh_token | length) > 0)
      | select((.expires_in | type) == "number" and .expires_in > 0)
    ' <<<"$resp" 2>/dev/null)"; then
    reason="$(jq -r '.error.message // "invalid token response"' <<<"$resp" 2>/dev/null \
      || printf 'invalid token response')"
    die "authorization failed: $reason"
  fi
  access="$(jq -r '.access_token' <<<"$token_json")" || die "could not read access token"
  refresh="$(jq -r '.refresh_token' <<<"$token_json")" || die "could not read refresh token"
  expires_in="$(jq -r '.expires_in' <<<"$token_json")" || die "could not read token expiry"
  scope="$(jq -r --arg fallback "$SCOPES" '
    if (.scope | type) == "string" then .scope
    elif (.scope | type) == "array" then (.scope | join(" "))
    else $fallback end
  ' <<<"$token_json")" || die "could not read token scopes"
  now_ms=$(( $(date +%s) * 1000 ))
  expires_at=$(( now_ms + expires_in * 1000 ))
  blob="$(jq -n --arg at "$access" --arg rt "$refresh" --argjson exp "$expires_at" \
    --arg scope "$scope" \
    '{claudeAiOauth:{accessToken:$at,refreshToken:$rt,expiresAt:$exp,scopes:($scope|split(" "))}}')" \
    || die "could not construct credential record"
  write_blob "$blob" || die "could not save claude-quota credentials"
  printf 'Authorization saved for claude-quota.\n' >&2
  printf '%s' "$access"
}

# ---- get a valid access token (refresh if needed) --------------------------
get_token() {
  local blob exp now_ms
  acquire_lock
  trap release_lock EXIT
  if [[ "$mode" == "--login" ]]; then
    authorize
    return
  fi
  if ! blob="$(read_blob)"; then
    authorize
    return
  fi
  if ! jq -e '
      (.claudeAiOauth | type) == "object"
      and (.claudeAiOauth.accessToken | type) == "string"
      and (.claudeAiOauth.accessToken | length) > 0
      and (.claudeAiOauth.refreshToken | type) == "string"
      and (.claudeAiOauth.refreshToken | length) > 0
      and (.claudeAiOauth.expiresAt | type) == "number"
    ' <<<"$blob" >/dev/null 2>&1; then
    echo "• stored claude-quota credentials are invalid — authorizing again…" >&2
    authorize
    return
  fi
  exp="$(jq -er '.claudeAiOauth.expiresAt' <<<"$blob")" \
    || die "could not read credential expiry"
  now_ms=$(( $(date +%s) * 1000 ))

  if (( now_ms < exp - REFRESH_SKEW_MS )); then
    jq -er '.claudeAiOauth.accessToken' <<<"$blob" \
      || die "could not read access token"
    return
  fi

  echo "• access token expired — refreshing…" >&2
  local refresh resp token_json access new_refresh expires_in new_exp new_blob reason
  refresh="$(jq -er '.claudeAiOauth.refreshToken' <<<"$blob")" \
    || die "could not read refresh token"
  resp="$(curl -sS -X POST "$TOKEN_URL" \
    -H "Content-Type: application/json" \
    -H "anthropic-beta: $OAUTH_BETA" \
    -H "User-Agent: $UA" \
    -d "$(jq -n --arg rt "$refresh" --arg cid "$CLIENT_ID" \
            '{grant_type:"refresh_token",refresh_token:$rt,client_id:$cid}')")" \
    || die "token refresh request failed"

  if ! token_json="$(jq -ce '
      select((.access_token | type) == "string" and (.access_token | length) > 0)
      | select((.expires_in | type) == "number" and .expires_in > 0)
    ' <<<"$resp" 2>/dev/null)"; then
    reason="$(jq -r '.error.message // "invalid token response"' <<<"$resp" 2>/dev/null \
      || printf 'invalid token response')"
    echo "• token refresh failed ($reason) — authorizing again…" >&2
    authorize
    return
  fi
  access="$(jq -r '.access_token' <<<"$token_json")" || die "could not read refreshed access token"
  new_refresh="$(jq -r '.refresh_token // empty' <<<"$token_json")" \
    || die "could not read rotated refresh token"
  [[ -n "$new_refresh" ]] || new_refresh="$refresh"   # fall back if not rotated
  expires_in="$(jq -r '.expires_in' <<<"$token_json")" || die "could not read refreshed expiry"
  new_exp=$(( now_ms + expires_in * 1000 ))

  # Update only claude-quota's app-specific credential blob.
  new_blob="$(jq --arg at "$access" --arg rt "$new_refresh" --argjson exp "$new_exp" \
    '.claudeAiOauth.accessToken=$at | .claudeAiOauth.refreshToken=$rt | .claudeAiOauth.expiresAt=$exp' \
    <<<"$blob")" || die "could not update stored credentials"
  write_blob "$new_blob" || die "could not save refreshed credentials"
  printf '%s' "$access"
}

# ---- fetch usage -----------------------------------------------------------
TOKEN="$(get_token)"
USAGE="$(curl -sS "$USAGE_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "anthropic-beta: $OAUTH_BETA" \
  -H "User-Agent: $UA")" || die "usage request failed"

jq -e 'has("five_hour")' <<<"$USAGE" >/dev/null 2>&1 || die "unexpected response: $USAGE"

# shared jq helpers: % left, and a humanized "time until reset"
JQ_HELPERS='
  def left: if .==null then null else (100 - .utilization) end;
  def secs(iso): if iso==null then null
    else ((iso|sub("\\.[0-9]+";"")|sub("\\+00:00";"Z")|fromdateiso8601) - now) end;
  def human(s): if s==null then "n/a" elif s<=0 then "now"
    else (s/86400|floor) as $d | ((s%86400)/3600|floor) as $h | ((s%3600)/60|floor) as $m
      | if $d>0 then "\($d)d\($h)h" elif $h>0 then "\($h)h\($m)m" else "\($m)m" end end;
'

# ---- output modes ----------------------------------------------------------
NOW_STR="$(date '+%-I:%M %p' | tr 'A-Z' 'a-z')"   # e.g. "11:06 pm" (local machine time)
case "$mode" in
  --json)
    jq . <<<"$USAGE" ;;

  --short|-s)
    jq -r --arg now "$NOW_STR" "$JQ_HELPERS"'
      [ (if .five_hour then "5h:\(.five_hour|left|floor)% left (\(human(secs(.five_hour.resets_at))))" else empty end),
        (if .seven_day then "7d:\(.seven_day|left|floor)% left (\(human(secs(.seven_day.resets_at))))" else empty end),
        "now \($now)"
      ] | join("  ·  ")' <<<"$USAGE" ;;

  full|""|--login)
    jq -r --arg now "$NOW_STR" "$JQ_HELPERS"'
      def bar(u): (u/5|floor) as $f | ("█"*$f) + ("░"*(20-$f));
      def row(lbl;w): if w==null then "  \(lbl|.+" "*(16-length))(not active)"
        else "  \(lbl|.+" "*(16-length))\(bar(w.utilization))  \((w|left|floor)|tostring|(" "*(3-length))+.)% left  (used \(w.utilization|floor)%)  resets in \(human(secs(w.resets_at)))" end;
      "\n  Claude Code quota",
      "  Current Time: \($now)",
      "  " + ("─"*70),
      row("5-hour session"; .five_hour),
      row("7-day (all)";    .seven_day),
      (if .seven_day_opus   then row("7-day Opus";   .seven_day_opus)   else empty end),
      (if .seven_day_sonnet then row("7-day Sonnet"; .seven_day_sonnet) else empty end),
      ""' <<<"$USAGE" ;;

esac
