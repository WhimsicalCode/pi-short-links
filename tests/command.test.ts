import assert from "node:assert/strict";
import test from "node:test";

import { CommandLinkService, parseShortUrl } from "../src/command.ts";
import { loadConfig } from "../src/config.ts";

test("command receives a JSON payload and its last output line is the short URL", async () => {
  const service = new CommandLinkService({
    command: `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log("connecting");console.log("https://go.example.com/"+p.version+"/"+encodeURIComponent(p.title)+"?u="+encodeURIComponent(p.url))})'`,
    timeoutMs: 10_000,
  });

  const result = await service.create({
    url: "https://example.com/long?token=secret",
    title: "Weekly",
  });

  assert.equal(
    result.shortUrl,
    `https://go.example.com/1/Weekly?u=${encodeURIComponent("https://example.com/long?token=secret")}`,
  );
  assert.equal(result.localOnly, false);
  assert.ok(result.warnings.some((warning) => warning.includes("token")));
});

test("command failures surface the exit code and last stderr line", async () => {
  const service = new CommandLinkService({
    command: "echo 'first' >&2; echo 'database unreachable' >&2; exit 3",
    timeoutMs: 10_000,
  });

  await assert.rejects(
    service.create({ url: "https://example.com" }),
    /exit code 3: database unreachable/,
  );
});

test("command timeouts are reported", async () => {
  const service = new CommandLinkService({
    command: "sleep 5",
    timeoutMs: 100,
  });

  await assert.rejects(
    service.create({ url: "https://example.com" }),
    /timed out after 100 ms/,
  );
});

test("invalid input is rejected before the command runs", async () => {
  const service = new CommandLinkService({
    command: "exit 99",
    timeoutMs: 10_000,
  });

  await assert.rejects(service.create({ url: "ftp://example.com" }));
});

test("short URL output must be an absolute http(s) URL", () => {
  assert.equal(
    parseShortUrl("log line\nhttps://s.example.com/abc\n"),
    "https://s.example.com/abc",
  );
  assert.throws(() => parseShortUrl("abc"), /absolute http\(s\) URL/);
  assert.throws(
    () => parseShortUrl("javascript:alert(1)"),
    /absolute http\(s\) URL/,
  );
  assert.throws(() => parseShortUrl(""), /absolute http\(s\) URL/);
});

test("command configuration is read from the environment", () => {
  assert.equal(loadConfig({}).command, null);
  assert.deepEqual(loadConfig({ PI_SHORT_LINKS_COMMAND: "shorten" }).command, {
    command: "shorten",
    timeoutMs: 30_000,
  });
  assert.deepEqual(
    loadConfig({
      PI_SHORT_LINKS_COMMAND: "shorten",
      PI_SHORT_LINKS_COMMAND_TIMEOUT_MS: "5000",
    }).command,
    { command: "shorten", timeoutMs: 5_000 },
  );
  assert.throws(
    () => loadConfig({ PI_SHORT_LINKS_COMMAND: " " }),
    /must not be empty/,
  );
  assert.throws(
    () =>
      loadConfig({
        PI_SHORT_LINKS_COMMAND: "shorten",
        PI_SHORT_LINKS_COMMAND_TIMEOUT_MS: "soon",
      }),
    /positive integer/,
  );
});
