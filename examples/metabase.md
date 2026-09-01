# Metabase example

Install and load both [`pi-metabase-links`](https://github.com/WhimsicalCode/pi-metabase-links) and this package. Then ask Pi for a Metabase link normally.

`pi-metabase-links` generates the full Metabase question URL in memory and sends it directly to the `pi-short-links:create:v1` event service. The model receives only a result like:

```text
Metabase link: http://127.0.0.1:8765/s/api-latency-dashboard-9xK2
Works only on this machine while Pi's short-links server is running.
```

Do not manually pass the Metabase URL to `create_short_link`; the two packages compose in-process. If `pi-short-links` is not loaded, `pi-metabase-links` falls back to its raw Metabase URL.

If a teammate needs to open the link, request a raw Metabase link instead. Local short links are not shareable across machines.
