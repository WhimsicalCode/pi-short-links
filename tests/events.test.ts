import assert from "node:assert/strict";
import test from "node:test";

import {
  registerShortLinkEventService,
  SHORT_LINK_CREATE_EVENT,
  type ShortLinkCreateRequestV1,
} from "../src/events.ts";
import type { ShortLinkResult } from "../src/command.ts";

const CREATED_LINK: ShortLinkResult = {
  shortUrl: "http://127.0.0.1:8765/s/monthly-users-abc",
  localOnly: true,
  warnings: [],
};

test("event service claims synchronously and delegates to link creation", async () => {
  let channel: string | undefined;
  let listener: ((data: unknown) => void) | undefined;
  let delegatedInput: unknown;
  let delegatedSource: string | undefined;
  const events = {
    on(name: string, handler: (data: unknown) => void) {
      channel = name;
      listener = handler;
      return () => {};
    },
  };
  const service = {
    async create(input: unknown, source: "extension") {
      delegatedInput = input;
      delegatedSource = source;
      return CREATED_LINK;
    },
  };
  registerShortLinkEventService(events, service);

  let claims = 0;
  const completed = deferred<ShortLinkResult>();
  const request: ShortLinkCreateRequestV1 = {
    version: 1,
    input: {
      url: "https://metabase.example.com/question#payload",
      title: "Monthly users",
    },
    claim() {
      claims += 1;
      return true;
    },
    resolve: completed.resolve,
    reject: completed.reject,
  };

  listener!(request);
  assert.equal(channel, SHORT_LINK_CREATE_EVENT);
  assert.equal(SHORT_LINK_CREATE_EVENT, "pi-short-links:create:v1");
  assert.equal(claims, 1);
  assert.deepEqual(await completed.promise, {
    shortUrl: "http://127.0.0.1:8765/s/monthly-users-abc",
    localOnly: true,
    warnings: [],
  });
  assert.deepEqual(delegatedInput, request.input);
  assert.equal(delegatedSource, "extension");
});

test("event service ignores malformed optional input without claiming it", () => {
  let listener: ((data: unknown) => void) | undefined;
  let creates = 0;
  const events = {
    on(_name: string, handler: (data: unknown) => void) {
      listener = handler;
      return () => {};
    },
  };
  registerShortLinkEventService(events, {
    async create() {
      creates += 1;
      return CREATED_LINK;
    },
  });
  let claims = 0;

  listener!({
    version: 1,
    input: {
      url: "https://example.com",
      tags: ["valid", 42],
    },
    claim() {
      claims += 1;
      return true;
    },
    resolve() {},
    reject() {},
  });

  assert.equal(claims, 0);
  assert.equal(creates, 0);
});

test("event service does no work when another listener claimed first", () => {
  let listener: ((data: unknown) => void) | undefined;
  let creates = 0;
  registerShortLinkEventService(
    {
      on(_name, handler) {
        listener = handler;
        return () => {};
      },
    },
    {
      async create() {
        creates += 1;
        return CREATED_LINK;
      },
    },
  );

  listener!({
    version: 1,
    input: { url: "https://example.com" },
    claim: () => false,
    resolve() {},
    reject() {},
  });

  assert.equal(creates, 0);
});

test("event service rejects the request when link creation fails", async () => {
  let listener: ((data: unknown) => void) | undefined;
  registerShortLinkEventService(
    {
      on(_name, handler) {
        listener = handler;
        return () => {};
      },
    },
    {
      async create() {
        throw new Error("no port available");
      },
    },
  );
  const completed = deferred<never>();

  listener!({
    version: 1,
    input: { url: "https://example.com" },
    claim: () => true,
    resolve: completed.resolve,
    reject: completed.reject,
  });

  await assert.rejects(completed.promise, /no port available/);
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
