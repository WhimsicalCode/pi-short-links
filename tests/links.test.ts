import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  base58,
  createPreparedLink,
  prepareLinkInput,
  ShortLinkService,
  slugify,
  type ServerController,
} from "../src/links.ts";
import { JsonLinkStore } from "../src/store.ts";
import { validateUrl } from "../src/url.ts";

async function temporaryStore() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "pi-short-links-core-"));
  const filePath = path.join(root, "links.json");
  return { root, filePath, store: new JsonLinkStore(filePath) };
}

test("validates schemes while preserving queries and fragments", () => {
  assert.equal(
    validateUrl(" https://example.com/path?b=2&a=1#question-state ").url,
    "https://example.com/path?b=2&a=1#question-state",
  );
  assert.throws(() => validateUrl("/relative"), /absolute http\(s\)/);
  assert.throws(
    () => validateUrl("file:///tmp/example"),
    /Unsupported URL scheme/,
  );
  assert.throws(
    () => validateUrl("javascript:alert(1)"),
    /Unsupported URL scheme/,
  );
});

test("warning detection is best effort and covers private IPv4 and IPv6", () => {
  assert.doesNotThrow(() => validateUrl("https://example.com/?token%ZZ=value"));
  assert.match(
    validateUrl("https://example.com/#/view?access_token=value").warnings[0],
    /access_token/,
  );

  for (const url of [
    "http://localhost/test",
    "http://127.0.0.1/test",
    "http://10.0.0.1/test",
    "http://[fc00::1]/test",
    "http://[fe80::1]/test",
    "http://[::ffff:127.0.0.1]/test",
  ]) {
    assert.match(validateUrl(url).warnings.join(" "), /private network/);
  }

  assert.doesNotMatch(
    validateUrl("http://fc00.example.com/test").warnings.join(" "),
    /private network/,
  );
});

test("detects every documented suspicious parameter name", () => {
  const names = [
    "token",
    "access_token",
    "refresh_token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "api_key",
    "apikey",
    "key",
    "session",
    "auth",
    "signature",
  ];
  const query = names.map((name) => `${name}=value`).join("&");
  const warning = validateUrl(`https://example.com/?${query}`).warnings.join(
    " ",
  );
  for (const name of names) assert.match(warning, new RegExp(`\\b${name}\\b`));
});

test("slugifies titles and caps generated slugs at 80 characters", async (context) => {
  const fixture = await temporaryStore();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  assert.equal(slugify("  API latency / dashboard  "), "api-latency-dashboard");

  const created = await createPreparedLink(
    fixture.store,
    prepareLinkInput({
      url: "https://example.com/long-title",
      title: "a".repeat(200),
    }),
    "tool",
  );
  assert.equal(created.link.slug.length, 80);
  assert.match(created.link.slug, /^[a-z0-9]+-[1-9A-HJ-NP-Za-km-z]{4}$/);
});

test("computes each documented expiration", async (context) => {
  const fixture = await temporaryStore();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const now = new Date("2026-01-01T00:00:00.000Z");
  const expected = {
    "1h": "2026-01-01T01:00:00.000Z",
    "1d": "2026-01-02T00:00:00.000Z",
    "7d": "2026-01-08T00:00:00.000Z",
    "30d": "2026-01-31T00:00:00.000Z",
    never: null,
  } as const;

  for (const [expiresIn, expiresAt] of Object.entries(expected)) {
    const created = await createPreparedLink(
      fixture.store,
      prepareLinkInput({
        url: `https://example.com/expires/${expiresIn}`,
        expiresIn: expiresIn as keyof typeof expected,
      }),
      "tool",
      now,
    );
    assert.equal(created.link.expiresAt, expiresAt);
  }
});

test("dedupes live links but creates a new link after expiry", async (context) => {
  const fixture = await temporaryStore();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const input = prepareLinkInput({
    url: "https://example.com/report",
    expiresIn: "1h",
  });
  const firstTime = new Date("2026-01-01T00:00:00.000Z");

  const first = await createPreparedLink(
    fixture.store,
    input,
    "tool",
    firstTime,
  );
  const duplicate = await createPreparedLink(
    fixture.store,
    input,
    "tool",
    new Date("2026-01-01T00:30:00.000Z"),
  );
  const afterExpiry = await createPreparedLink(
    fixture.store,
    input,
    "tool",
    new Date("2026-01-01T02:00:00.000Z"),
  );

  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.link.slug, first.link.slug);
  assert.equal(afterExpiry.deduped, false);
  assert.equal(afterExpiry.collisionResolved, true);
  assert.notEqual(afterExpiry.link.slug, first.link.slug);
  assert.equal(Object.keys((await fixture.store.read()).links).length, 2);
});

test("uses each deterministic suffix length before a numeric fallback", async (context) => {
  const fixture = await temporaryStore();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const firstInput = prepareLinkInput({ url: "https://example.com/no-dedupe" });
  const repeatedInput = prepareLinkInput({
    url: "https://example.com/no-dedupe",
    dedupe: false,
  });

  const created = [
    await createPreparedLink(fixture.store, firstInput, "tool"),
    await createPreparedLink(fixture.store, repeatedInput, "tool"),
    await createPreparedLink(fixture.store, repeatedInput, "tool"),
    await createPreparedLink(fixture.store, repeatedInput, "tool"),
    await createPreparedLink(fixture.store, repeatedInput, "tool"),
  ];

  assert.deepEqual(
    created.map(({ link }) => link.slug.slice("link-".length).length),
    [4, 5, 6, 8, 10],
  );
  assert.match(created[4].link.slug, /-2$/);
  assert.equal(created[0].collisionResolved, false);
  assert.equal(
    created.slice(1).every((link) => link.collisionResolved),
    true,
  );
});

test("uses Bitcoin Base58 and preserves leading zero bytes", () => {
  assert.equal(base58(Buffer.from([0])), "1");
  assert.equal(base58(Buffer.from([0, 0, 1])), "112");
  assert.doesNotMatch(base58(Buffer.from("test")), /[0OIl]/);
});

test("rejects invalid and expired custom slugs clearly", async (context) => {
  const fixture = await temporaryStore();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  assert.throws(
    () => prepareLinkInput({ url: "https://example.com", slug: "" }),
    /Invalid slug/,
  );

  const input = prepareLinkInput({
    url: "https://example.com/custom",
    slug: "custom-link",
    expiresIn: "1h",
  });
  await createPreparedLink(
    fixture.store,
    input,
    "tool",
    new Date("2026-01-01T00:00:00.000Z"),
  );
  await assert.rejects(
    createPreparedLink(
      fixture.store,
      input,
      "tool",
      new Date("2026-01-01T02:00:00.000Z"),
    ),
    /already exists but is expired/,
  );

  const caseSensitive = await createPreparedLink(
    fixture.store,
    prepareLinkInput({
      url: "https://example.com/case-sensitive",
      slug: "Release-Notes",
    }),
    "tool",
  );
  assert.equal(caseSensitive.link.slug, "Release-Notes");
  await assert.rejects(
    createPreparedLink(
      fixture.store,
      prepareLinkInput({
        url: "https://example.com/different-target",
        slug: "Release-Notes",
      }),
      "tool",
    ),
    /different target URL/,
  );
});

test("does not write a link when server startup fails", async (context) => {
  const fixture = await temporaryStore();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const failingServer: ServerController = {
    async start() {
      throw new Error("no ports available");
    },
  };
  const service = new ShortLinkService(fixture.store, failingServer);

  await assert.rejects(
    service.create({ url: "https://example.com/not-saved" }, "tool"),
    /no ports available/,
  );
  await assert.rejects(fs.access(fixture.filePath));
});

test("serializes concurrent link creation", async (context) => {
  const fixture = await temporaryStore();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      createPreparedLink(
        fixture.store,
        prepareLinkInput({ url: `https://example.com/concurrent/${index}` }),
        "tool",
      ),
    ),
  );

  assert.equal(Object.keys((await fixture.store.read()).links).length, 40);
});
