import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PI_AVAILABLE =
  spawnSync("pi", ["--version"], {
    stdio: "ignore",
  }).status === 0;
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test(
  "Pi discovers the package and owns the redirect server lifecycle",
  { skip: !PI_AVAILABLE },
  async (context) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "pi-short-links-pi-"));
    const storePath = path.join(root, "links.json");
    const port = await availablePort();
    const child = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-builtin-tools",
        "-e",
        PACKAGE_ROOT,
      ],
      {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          PI_SHORT_LINKS_PORT: String(port),
          PI_SHORT_LINKS_PORT_END: String(port),
          PI_SHORT_LINKS_STORE: storePath,
        },
        stdio: "pipe",
      },
    );
    const rpc = new RpcClient(child);

    context.after(async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await waitForExit(child);
      await fs.rm(root, { recursive: true, force: true });
    });

    const commands = await rpc.request("get_commands");
    assert(isRecord(commands.data) && Array.isArray(commands.data.commands));
    const names = commands.data.commands.map((command: unknown) => {
      assert(isRecord(command) && typeof command.name === "string");
      return command.name;
    });
    assert(names.includes("short-link"));
    assert(names.includes("short-links"));
    assert(names.includes("skill:short-links"));

    const target = "https://example.com/pi-integration?view=compact#state";
    await rpc.prompt(`/short-link ${target}`);
    const data = JSON.parse(await fs.readFile(storePath, "utf8"));
    const slug = Object.keys(data.links)[0];
    const baseUrl = `http://127.0.0.1:${port}`;
    const shortUrl = `${baseUrl}/s/${slug}`;

    const redirect = await fetch(shortUrl, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), target);

    rpc.clearEvents();
    await rpc.prompt("/short-links list");
    const listMessage = rpc.lastNotification();
    assert.match(listMessage, new RegExp(slug));
    assert.doesNotMatch(listMessage, /example\.com\/pi-integration/);

    rpc.clearEvents();
    await rpc.prompt("/short-links status");
    assert.match(rpc.lastNotification(), /server: running/);

    await rpc.prompt("/short-links stop");
    await assert.rejects(fetchWithShortTimeout(`${baseUrl}/healthz`));

    rpc.clearEvents();
    await rpc.prompt("/short-links list");
    const stoppedList = rpc.lastNotification();
    assert.match(stoppedList, /server stopped/);
    assert.doesNotMatch(stoppedList, /http:\/\/127\.0\.0\.1/);

    rpc.clearEvents();
    await rpc.prompt("/short-links status");
    assert.match(rpc.lastNotification(), /server: stopped/);

    await rpc.prompt("/short-links start");
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    await rpc.prompt("/short-links stop");

    await rpc.prompt(
      "/short-links create https://example.com/restarted#fragment",
    );
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);

    child.kill("SIGTERM");
    await waitForExit(child);
    await assert.rejects(
      fetchWithShortTimeout(`http://127.0.0.1:${port}/healthz`),
    );
  },
);

class RpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    { resolve: (value: RpcMessage) => void; reject: (error: Error) => void }
  >();
  private events: RpcMessage[] = [];
  private buffer = "";
  private nextId = 1;
  private stderr = "";

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    child.once("exit", () => {
      for (const request of this.pending.values()) {
        request.reject(
          new Error(`Pi exited before responding. ${this.stderr}`),
        );
      }
      this.pending.clear();
    });
  }

  request(
    type: string,
    extra: Record<string, unknown> = {},
  ): Promise<RpcMessage> {
    const id = `test-${this.nextId++}`;
    const response = new Promise<RpcMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(
          new Error(`Timed out waiting for Pi RPC response. ${this.stderr}`),
        );
      }, 10_000).unref();
    });
    this.child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    return response;
  }

  async prompt(message: string): Promise<RpcMessage> {
    return this.request("prompt", { message });
  }

  clearEvents(): void {
    this.events = [];
  }

  lastNotification(): string {
    const notification = this.events
      .filter(
        (event) =>
          event.type === "extension_ui_request" && event.method === "notify",
      )
      .at(-1);
    assert(notification && typeof notification.message === "string");
    return notification.message;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;

      const message = JSON.parse(line) as RpcMessage;
      this.events.push(message);
      if (message.type !== "response" || typeof message.id !== "string") {
        continue;
      }
      const request = this.pending.get(message.id);
      if (!request) continue;
      this.pending.delete(message.id);
      if (message.success === false) {
        request.reject(
          new Error(String(message.error ?? "Pi RPC request failed")),
        );
      } else {
        request.resolve(message);
      }
    }
  }
}

type RpcMessage = {
  id?: string;
  type: string;
  success?: boolean;
  error?: unknown;
  method?: string;
  message?: unknown;
  data?: unknown;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
