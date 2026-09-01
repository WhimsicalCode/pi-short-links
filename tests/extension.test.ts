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
  const api = {
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
  await assert.rejects(
    fetchWithShortTimeout(`http://127.0.0.1:${port}/healthz`),
  );
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
