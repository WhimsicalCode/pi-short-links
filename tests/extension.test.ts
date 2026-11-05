import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import shortLinksExtension from "../extensions/short-links.ts";

const MANAGED_ENVIRONMENT = [
  "PI_SHORT_LINKS_PORT",
  "PI_SHORT_LINKS_PORT_END",
  "PI_SHORT_LINKS_STORE",
] as const;

test("registers a lazy tool with the documented result and shutdown", async (context) => {
  const root = await fs.mkdtemp(
    path.join(tmpdir(), "pi-short-links-extension-"),
  );
  const storePath = path.join(root, "links.json");
  const port = await availablePort();
  const previous = Object.fromEntries(
    MANAGED_ENVIRONMENT.map((name) => [name, process.env[name]]),
  );
  process.env.PI_SHORT_LINKS_PORT = String(port);
  process.env.PI_SHORT_LINKS_PORT_END = String(port);
  process.env.PI_SHORT_LINKS_STORE = storePath;

  let capturedTool: CapturedTool | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let eventChannel: string | undefined;
  let eventHandler: ((data: unknown) => void) | undefined;
  let unsubscribed = 0;
  const api = {
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        eventChannel = channel;
        eventHandler = handler;
        return () => {
          unsubscribed += 1;
        };
      },
    },
    registerTool(definition: unknown) {
      capturedTool = definition as CapturedTool;
    },
    registerCommand() {},
    on(event: string, handler: unknown) {
      if (event === "session_shutdown") {
        shutdown = handler as () => Promise<void>;
      }
    },
  } as unknown as ExtensionAPI;

  context.after(async () => {
    if (shutdown) await shutdown();
    for (const name of MANAGED_ENVIRONMENT) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  shortLinksExtension(api);
  const tool = requireCaptured(capturedTool, "tool");
  const shutdownHandler = requireCaptured(shutdown, "shutdown handler");
  assert.equal(tool.name, "create_short_link");
  assert.match(tool.description, /only on this machine/);
  assert.equal(eventChannel, "pi-short-links:create:v1");
  assert.ok(eventHandler);
  await assert.rejects(
    fetchWithShortTimeout(`http://127.0.0.1:${port}/healthz`),
  );

  const result = await tool.execute(
    "test-call",
    {
      url: "https://example.com/tool?token=value#state",
      title: "Tool result",
      expiresIn: "1d",
    },
    undefined,
    undefined,
    {},
  );

  assert.match(result.content[0].text, /Local short link:/);
  assert.match(result.content[0].text, /only on this machine/);
  assert.match(result.content[0].text, /may carry secrets: token/);
  assert.equal(result.details.localOnly, true);
  assert.equal(result.details.deduped, false);
  assert.equal(result.details.collisionResolved, false);
  assert.equal(result.details.server.started, true);
  assert.equal(result.details.server.port, port);
  assert.equal(
    result.details.targetUrl,
    "https://example.com/tool?token=value#state",
  );
  assert.match(result.details.slug, /^tool-result-/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);

  await shutdownHandler();
  shutdown = undefined;
  assert.equal(unsubscribed, 1);
  await assert.rejects(
    fetchWithShortTimeout(`http://127.0.0.1:${port}/healthz`),
  );
});

test("uses PI_SHORT_LINKS_COMMAND for the tool and the event service", async (context) => {
  const previous = process.env.PI_SHORT_LINKS_COMMAND;
  process.env.PI_SHORT_LINKS_COMMAND =
    "cat >/dev/null; echo https://s.example.com/abc";
  context.after(() => {
    if (previous === undefined) delete process.env.PI_SHORT_LINKS_COMMAND;
    else process.env.PI_SHORT_LINKS_COMMAND = previous;
  });

  let capturedTool: CapturedTool | undefined;
  let eventHandler: ((data: unknown) => void) | undefined;
  const api = {
    events: {
      on(_channel: string, handler: (data: unknown) => void) {
        eventHandler = handler;
        return () => {};
      },
    },
    registerTool(definition: unknown) {
      capturedTool = definition as CapturedTool;
    },
    registerCommand() {},
    on() {},
  } as unknown as ExtensionAPI;

  shortLinksExtension(api);
  const tool = requireCaptured(capturedTool, "tool");
  assert.doesNotMatch(tool.description, /only on this machine/);

  const result = await tool.execute(
    "test-call",
    { url: "https://example.com/report" },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(
    result.content[0]?.text,
    "Short link: https://s.example.com/abc",
  );
  assert.equal(result.details.localOnly, false);

  const resolved = await new Promise((resolve, reject) => {
    requireCaptured(
      eventHandler,
      "event handler",
    )({
      version: 1,
      input: { url: "https://example.com/report" },
      claim: () => true,
      resolve,
      reject,
    });
  });
  assert.deepEqual(resolved, {
    shortUrl: "https://s.example.com/abc",
    localOnly: false,
    warnings: [],
  });
});

type CapturedTool = {
  name: string;
  description: string;
  execute(
    toolCallId: string,
    parameters: {
      url: string;
      title?: string;
      expiresIn?: "1h" | "1d" | "7d" | "30d" | "never";
    },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: {
      localOnly: boolean;
      deduped: boolean;
      collisionResolved: boolean;
      targetUrl: string;
      slug: string;
      server: { started: boolean; port: number };
    };
  }>;
};

function requireCaptured<T>(value: T | undefined, label: string): T {
  if (value === undefined)
    throw new Error(`Extension did not register ${label}.`);
  return value;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

function fetchWithShortTimeout(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(500) });
}
