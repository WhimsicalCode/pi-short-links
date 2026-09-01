# pi-short-links

Create short local links for long URLs generated during Pi agent work.

```text
Long URL -> http://127.0.0.1:8765/s/api-latency-dashboard-9xK2
```

The local URL redirects to the full target URL while Pi's short-links server is running in the current process. The server stays up until the Pi session ends or you run `/short-links stop`.

## Local-only behavior

Links created by this package work only on this machine while Pi is running the short-links server. The target URLs are persisted locally, but the redirect server starts lazily when a link is created or when you run `/short-links start`, and stops on Pi session shutdown or `/short-links stop`.

Hosted/team-shareable short links are not included.

## Install

From this directory:

```bash
pi install ~/pi-short-links
```

For a one-off test:

```bash
pi -e ~/pi-short-links
```

## Usage

Ask Pi for a short link, or use a command:

```text
/short-link https://example.com/a/very/long/url
/short-links create https://example.com/a/very/long/url
/short-links list
/short-links start
/short-links status
/short-links stop
```

The model can also call the `create_short_link` tool with optional `title`, `description`, `tags`, `slug`, `expiresIn`, and `dedupe` fields.

A result looks like this:

```text
Local short link: http://127.0.0.1:8765/s/link-f3Tq
Works only on this machine while Pi's short-links server is running.
```

## Storage

The package stores links as JSON here:

```text
~/.pi/agent/short-links/links.json
```

The store contains full target URLs. The default directory is readable only by your user, and the JSON file is written with `0600` permissions. `/short-links list` and the index page hide full targets by default.

## Configuration

No configuration is required. These environment variables are available when the defaults do not fit:

```text
PI_SHORT_LINKS_HOST=127.0.0.1
PI_SHORT_LINKS_PORT=8765
PI_SHORT_LINKS_PORT_END=8799
PI_SHORT_LINKS_STORE=~/.pi/agent/short-links/links.json
```

V1 accepts only `127.0.0.1` as the host. Invalid ports, ranges, hosts, and empty store paths fail with a clear startup error.

## Behavior

- Accepts absolute `http:` and `https:` URLs only.
- Preserves query strings and fragments.
- Warns on suspicious parameter names like `token`, `password`, `api_key`, and `session`.
- Warns for localhost/private-network targets.
- Binds only to `127.0.0.1`.
- Uses preferred port `8765`, falling back through `8799`.
- Link creation makes no external network calls.
- Serializes writes made by one Pi process so parallel tool calls do not lose links.
- Does not return an expired link when deduplicating a URL.
- Nothing keeps running after Pi exits.

## Development

```bash
npm install
npm run check
npm run test:coverage
```
