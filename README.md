# pi-short-links

Create short local links for long URLs generated during Pi agent work.

```text
Long URL -> http://127.0.0.1:8765/s/api-latency-dashboard-9xK2
```

The local URL redirects to the full target URL while Pi's short-links server is running in the current process. The server stays up until the Pi session ends or you run `/short-links stop`.

## Local-only behavior

Links created by this package work only on this machine while Pi is running the short-links server. The target URLs are persisted locally, but the redirect server starts lazily when a link is created or when you run `/short-links start`, and stops on Pi session shutdown or `/short-links stop`.

Hosted/team-shareable short links are not built in, but you can plug in your own with a [short-link command](#team-shareable-links-with-a-command).

## Install

The simplest:

```bash
pi install git:github.com/WhimsicalCode/pi-short-links
```

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

Other Pi extensions can create links without routing a long target through the model. `pi-short-links` exposes the versioned in-process event service `pi-short-links:create:v1`. It accepts the same generic URL metadata (except custom `slug`) and returns only the local short URL, local-only flag, and warnings. If no service claims an event request, the calling extension remains responsible for its own fallback.

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

## Team-shareable links with a command

Local links break as soon as someone else, or a CI job, needs to open them. If you already have somewhere shared to store links and something that redirects from it, point the extension at a command that creates one:

```bash
export PI_SHORT_LINKS_COMMAND="$HOME/bin/shorten"
```

When `PI_SHORT_LINKS_COMMAND` is set, `create_short_link`, `/short-link`, `/short-links create`, and the `pi-short-links:create:v1` event service all use the command instead of the local store and server. The extension runs it with `/bin/sh -c` and:

- writes one line of JSON to its stdin: `{"version": 1, "url": "...", "title": ..., "description": ..., "tags": [...], "slug": ..., "expiresIn": "..."}`. Only `url` is guaranteed to be meaningful; the command may ignore the rest.
- reads the short URL from the last line of stdout. It must be an absolute `http:` or `https:` URL.
- treats a non-zero exit code as a failure and reports the last line of stderr.
- stops the command after 30 seconds (`PI_SHORT_LINKS_COMMAND_TIMEOUT_MS` to change it).

Results report `localOnly: false`. The URL validation and warnings described under [Behavior](#behavior) still apply before the command runs. Where the command stores links and who can open them is up to it, so keep credentials and allowlists in the command, not in Pi's environment.

A minimal command:

```bash
#!/usr/bin/env bash
set -euo pipefail
url=$(jq -r .url)
id=$(printf %s "$url" | shasum -a 256 | cut -c1-8)
# ...store "$id" -> "$url" wherever your redirect service reads from...
echo "https://links.example.com/$id"
```

## Configuration

No configuration is required. These environment variables are available when the defaults do not fit:

```text
PI_SHORT_LINKS_HOST=127.0.0.1
PI_SHORT_LINKS_PORT=8765
PI_SHORT_LINKS_PORT_END=8799
PI_SHORT_LINKS_STORE=~/.pi/agent/short-links/links.json
PI_SHORT_LINKS_COMMAND=            # unset: local links (see above)
PI_SHORT_LINKS_COMMAND_TIMEOUT_MS=30000
```

V1 accepts only `127.0.0.1` as the host. Invalid ports, ranges, hosts, and empty store paths fail with a clear startup error.

## Behavior

- Accepts absolute `http:` and `https:` URLs only.
- Preserves query strings and fragments.
- Warns on suspicious parameter names like `token`, `password`, `api_key`, and `session`.
- Warns for localhost/private-network targets.
- Binds only to `127.0.0.1`.
- Uses preferred port `8765`, falling back through `8799`.
- Link creation makes no external network calls (unless your `PI_SHORT_LINKS_COMMAND` does).
- Serializes writes made by one Pi process so parallel tool calls do not lose links.
- Does not return an expired link when deduplicating a URL.
- Provides a generic in-process event service for optional extension composition.
- Nothing keeps running after Pi exits.

## Development

```bash
npm install
npm run check
npm run test:coverage
```
