# Compatibility decisions

## Keep the Claude Code-compatible user agent

`claude-quota` intentionally does not replace the current
`claude-cli/... (external, cli)` user agent with a made-up application identity.

The authorization flow uses Claude Code's public OAuth client ID and an internal
Claude Code usage endpoint. Anthropic associates the browser consent identity,
allowed redirects, and scopes with that client ID—not with the HTTP user-agent
header. Changing only the header would create a contradictory request: it would
still be a Claude Code OAuth client while claiming to be an independently
registered application, and it would not change what the consent page displays.

Do not change the user agent independently. Replace it only as part of a future
migration to an Anthropic-issued client ID and supported endpoint for this app.
Until then, this integration remains undocumented and may stop working; users
must use it only with their own account and accept that compatibility risk.
