# Metabase example

When another Pi package generates a long Metabase question URL, pass it to `create_short_link`:

```text
Metabase question URL -> create_short_link(title: "API latency dashboard", tags: ["metabase", "ops"])
```

Suggested response:

```text
Here's the local short Metabase link:
http://127.0.0.1:8765/s/api-latency-dashboard-9xK2

It works only on this machine while Pi's short-links server is running.
```

If a teammate needs to open the link, do not use this package. Return the original Metabase URL or use an approved shareable-link workflow instead.
