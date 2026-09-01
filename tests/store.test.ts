import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonLinkStore } from "../src/store.ts";
import { makeLink } from "./helpers.ts";

async function temporaryStore(secureDirectory = false) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "pi-short-links-store-"));
  const directory = path.join(root, "registry");
  const filePath = path.join(directory, "links.json");
  return {
    root,
    directory,
    filePath,
    store: new JsonLinkStore(filePath, { secureDirectory }),
  };
}

test("serializes concurrent mutations without losing links", async (context) => {
  const fixture = await temporaryStore();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      fixture.store.mutate(async (data) => {
        await new Promise((resolve) => setTimeout(resolve, index % 3));
        const slug = `link-${index}`;
        data.links[slug] = makeLink(slug);
        return { value: undefined, changed: true };
      }),
    ),
  );

  const data = await fixture.store.read();
  assert.equal(Object.keys(data.links).length, 50);
  assert.deepEqual((await fs.readdir(fixture.directory)).sort(), [
    "links.json",
  ]);
});

test("writes private store and directory permissions", async (context) => {
  const fixture = await temporaryStore(true);
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  await fixture.store.mutate((data) => {
    data.links.example = makeLink("example");
    return { value: undefined, changed: true };
  });

  if (process.platform !== "win32") {
    const directoryMode = (await fs.stat(fixture.directory)).mode & 0o777;
    const fileMode = (await fs.stat(fixture.filePath)).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(fileMode, 0o600);
  }
});

test("tightens permissions on an existing default store", async (context) => {
  const fixture = await temporaryStore(true);
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.mkdir(fixture.directory, { recursive: true, mode: 0o755 });
  await fs.chmod(fixture.directory, 0o755);
  await fs.writeFile(
    fixture.filePath,
    JSON.stringify({ version: 1, links: { example: makeLink("example") } }),
    { mode: 0o644 },
  );
  await fs.chmod(fixture.filePath, 0o644);

  await fixture.store.read();

  if (process.platform !== "win32") {
    assert.equal((await fs.stat(fixture.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(fixture.filePath)).mode & 0o777, 0o600);
  }
});

test("refuses malformed JSON without overwriting it", async (context) => {
  const fixture = await temporaryStore();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.mkdir(fixture.directory, { recursive: true });
  await fs.writeFile(fixture.filePath, "{not-json", "utf8");

  await assert.rejects(fixture.store.read(), /contains invalid JSON/);
  assert.equal(await fs.readFile(fixture.filePath, "utf8"), "{not-json");
});

test("distinguishes unsupported versions from invalid v1 records", async (context) => {
  const fixture = await temporaryStore();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.mkdir(fixture.directory, { recursive: true });

  await fs.writeFile(
    fixture.filePath,
    JSON.stringify({ version: 2, links: {} }),
  );
  await assert.rejects(
    fixture.store.read(),
    /Unsupported short-links store version/,
  );

  await fs.writeFile(
    fixture.filePath,
    JSON.stringify({ version: 1, links: { broken: { slug: "broken" } } }),
  );
  await assert.rejects(fixture.store.read(), /invalid v1 structure/);
});
