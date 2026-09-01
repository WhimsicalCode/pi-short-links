import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPreparedLink,
  prepareLinkInput,
  ShortLinkService,
} from "../src/links.ts";
import { RedirectServer } from "../src/server.ts";
import { JsonLinkStore } from "../src/store.ts";

async function temporaryFixture(portStart = 0, portEnd = portStart) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "pi-short-links-server-"));
  const store = new JsonLinkStore(path.join(root, "links.json"));
  const server = new RedirectServer(
    { host: "127.0.0.1", portStart, portEnd },
    store,
  );
  const links = new ShortLinkService(store, server);
  return { root, store, server, links };
}

test("serves health, redirects, missing links, and expired links", async (context) => {
  const fixture = await temporaryFixture();
  context.after(async () => {
    await fixture.server.stop();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const created = await fixture.links.create(
    { url: "https://example.com/report?view=compact#section" },
    "tool",
  );
  const repeatedStart = await fixture.server.start();
  assert.equal(repeatedStart.started, true);
  assert.equal(repeatedStart.port, created.server.port);

  const baseUrl = `http://${created.server.host}:${created.server.port}`;
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    links: 1,
    host: "127.0.0.1",
    port: created.server.port,
  });

  const redirect = await fetch(
    `${baseUrl}/s/${encodeURIComponent(created.link.slug)}`,
    { redirect: "manual" },
  );
  assert.equal(redirect.status, 302);
  assert.equal(
    redirect.headers.get("location"),
    "https://example.com/report?view=compact#section",
  );
  assert.equal(
    (await fixture.store.read()).links[created.link.slug].accessCount,
    1,
  );

  await Promise.all(
    Array.from({ length: 20 }, () =>
      fetch(`${baseUrl}/s/${encodeURIComponent(created.link.slug)}`, {
        redirect: "manual",
      }),
    ),
  );
  assert.equal(
    (await fixture.store.read()).links[created.link.slug].accessCount,
    21,
  );

  assert.equal((await fetch(`${baseUrl}/s/missing`)).status, 404);
  assert.equal(
    (await fetch(`${baseUrl}/healthz`, { method: "POST" })).status,
    405,
  );

  const expired = await createPreparedLink(
    fixture.store,
    prepareLinkInput({
      url: "https://example.com/expired",
      expiresIn: "1h",
    }),
    "tool",
    new Date("2020-01-01T00:00:00.000Z"),
  );
  assert.equal((await fetch(`${baseUrl}/s/${expired.link.slug}`)).status, 410);

  await createPreparedLink(
    fixture.store,
    prepareLinkInput({
      url: "https://example.com/private-target",
      title: '<script>alert("x")</script>',
    }),
    "tool",
  );
  const indexResponse = await fetch(`${baseUrl}/`);
  const index = await indexResponse.text();
  assert.match(
    indexResponse.headers.get("content-security-policy") ?? "",
    /default-src 'none'/,
  );
  assert.match(index, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(index, /<script>alert/);
  assert.doesNotMatch(index, /https:\/\/example\.com\/private-target/);
});

test("falls back when the preferred port is occupied", async (context) => {
  const occupied = createServer();
  await listen(occupied, 0);
  const address = occupied.address();
  assert(address && typeof address === "object");
  const preferred = address.port;
  const fixture = await temporaryFixture(preferred, preferred + 5);

  context.after(async () => {
    await fixture.server.stop();
    await close(occupied);
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const running = await fixture.server.start();
  assert.notEqual(running.port, preferred);
  assert(running.port > preferred);
  assert.equal(
    (await fetch(`http://127.0.0.1:${running.port}/healthz`)).status,
    200,
  );
});

test("does not save a link when every configured port is occupied", async (context) => {
  const occupied = createServer();
  await listen(occupied, 0);
  const address = occupied.address();
  assert(address && typeof address === "object");
  const fixture = await temporaryFixture(address.port, address.port);

  context.after(async () => {
    await fixture.server.stop();
    await close(occupied);
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  await assert.rejects(
    fixture.links.create({ url: "https://example.com/not-written" }, "tool"),
    /no available port/,
  );
  await assert.rejects(fs.access(path.join(fixture.root, "links.json")));
});

test("a stop queued during startup leaves no running server", async (context) => {
  const fixture = await temporaryFixture();
  context.after(async () => {
    await fixture.server.stop();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const starting = fixture.server.start();
  const stopping = fixture.server.stop();
  const running = await starting;
  assert.equal(running.started, true);
  assert.equal(await stopping, true);
  assert.equal(await fixture.server.stop(), false);
  assert.equal(fixture.server.status().running, false);
});

test("stop does not wait for an incomplete HTTP request", async (context) => {
  const fixture = await temporaryFixture();
  let socket: Socket | undefined;
  context.after(async () => {
    socket?.destroy();
    await fixture.server.stop();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const running = await fixture.server.start();
  socket = await openSocket(running.port);
  socket.write("GET /healthz HTTP/1.1\r\nHost: localhost\r\n");

  await Promise.race([
    fixture.server.stop(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("server stop timed out")), 1_000),
    ),
  ]);
  assert.equal(fixture.server.status().running, false);
});

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function openSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
