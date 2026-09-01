import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { expandHome, loadConfig } from "../src/config.ts";

test("loads safe defaults", () => {
  const config = loadConfig({});
  assert.deepEqual(config.server, {
    host: "127.0.0.1",
    portStart: 8765,
    portEnd: 8799,
  });
  assert.equal(
    config.storePath,
    path.join(homedir(), ".pi/agent/short-links/links.json"),
  );
  assert.equal(config.secureStoreDirectory, true);
});

test("accepts a valid custom range and store", () => {
  const config = loadConfig({
    PI_SHORT_LINKS_PORT: "9000",
    PI_SHORT_LINKS_PORT_END: "9002",
    PI_SHORT_LINKS_STORE: "/tmp/short-links.json",
  });
  assert.equal(config.server.portStart, 9000);
  assert.equal(config.server.portEnd, 9002);
  assert.equal(config.storePath, "/tmp/short-links.json");
  assert.equal(config.secureStoreDirectory, false);
});

test("rejects invalid ports, ranges, hosts, and store paths", () => {
  assert.throws(
    () => loadConfig({ PI_SHORT_LINKS_PORT: "abc" }),
    /expected an integer/,
  );
  assert.throws(
    () => loadConfig({ PI_SHORT_LINKS_PORT: "0" }),
    /expected an integer/,
  );
  assert.throws(
    () =>
      loadConfig({
        PI_SHORT_LINKS_PORT: "9001",
        PI_SHORT_LINKS_PORT_END: "9000",
      }),
    /port range/,
  );
  assert.throws(
    () => loadConfig({ PI_SHORT_LINKS_HOST: "0.0.0.0" }),
    /binds only to 127\.0\.0\.1/,
  );
  assert.throws(
    () => loadConfig({ PI_SHORT_LINKS_STORE: "  " }),
    /must not be empty/,
  );
});

test("expands only the current user's home shorthand", () => {
  assert.equal(expandHome("~/links.json"), path.join(homedir(), "links.json"));
  assert.equal(expandHome("/tmp/links.json"), "/tmp/links.json");
});
