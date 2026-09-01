import { createHash } from "node:crypto";
import type { RunningServer } from "./server.ts";
import { JsonLinkStore } from "./store.ts";
import {
  isExpired,
  type CreateLinkInput,
  type CreateLinkResult,
  type ExpiresIn,
  type LinkRecord,
  type Store,
} from "./types.ts";
import { validateUrl } from "./url.ts";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type PreparedLinkInput = {
  targetUrl: string;
  warnings: string[];
  title?: string;
  description?: string;
  tags: string[];
  slug?: string;
  expiresIn: ExpiresIn;
  dedupe: boolean;
};

export type ServerController = {
  start(): Promise<RunningServer>;
};

export type CreatedShortLink = CreateLinkResult & {
  server: RunningServer;
};

export class ShortLinkService {
  private readonly store: JsonLinkStore;
  private readonly server: ServerController;

  constructor(store: JsonLinkStore, server: ServerController) {
    this.store = store;
    this.server = server;
  }

  async create(
    input: CreateLinkInput,
    source: "tool" | "command",
  ): Promise<CreatedShortLink> {
    const prepared = prepareLinkInput(input);
    const server = await this.server.start();
    const created = await createPreparedLink(this.store, prepared, source);
    return { ...created, server };
  }
}

export function prepareLinkInput(input: CreateLinkInput): PreparedLinkInput {
  const validated = validateUrl(input.url);

  if (input.slug !== undefined) {
    if (!/^[A-Za-z0-9-]+$/.test(input.slug)) {
      throw new Error("Invalid slug: use letters, numbers, and hyphens only.");
    }
    if (input.slug.length > 80) {
      throw new Error("Invalid slug: maximum length is 80 characters.");
    }
  }

  return {
    targetUrl: validated.url,
    warnings: validated.warnings,
    title: input.title,
    description: input.description,
    tags: [...(input.tags ?? [])],
    slug: input.slug,
    expiresIn: input.expiresIn ?? "never",
    dedupe: input.dedupe ?? true,
  };
}

export async function createPreparedLink(
  store: JsonLinkStore,
  input: PreparedLinkInput,
  source: "tool" | "command",
  now = new Date(),
): Promise<CreateLinkResult> {
  const nowMs = now.getTime();
  const targetUrlHash = hashUrl(input.targetUrl);

  return store.mutate((data) => {
    if (input.dedupe) {
      const existing = Object.values(data.links).find(
        (link) => link.targetUrl === input.targetUrl && !isExpired(link, nowMs),
      );
      if (existing) {
        return {
          value: result(existing, true, false, input.warnings),
          changed: false,
        };
      }
    }

    const selection = input.slug
      ? selectCustomSlug(data, input, nowMs)
      : selectGeneratedSlug(data, input, nowMs);

    if (selection.existing) {
      return {
        value: result(
          selection.existing,
          true,
          selection.collisionResolved,
          input.warnings,
        ),
        changed: false,
      };
    }

    const timestamp = now.toISOString();
    const link: LinkRecord = {
      id: selection.slug,
      slug: selection.slug,
      targetUrl: input.targetUrl,
      targetUrlHash,
      title: input.title?.trim() || null,
      description: input.description?.trim() || null,
      tags: input.tags,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: expirationDate(input.expiresIn, nowMs),
      lastAccessedAt: null,
      accessCount: 0,
      source,
      metadata: {},
    };
    data.links[link.slug] = link;

    return {
      value: result(link, false, selection.collisionResolved, input.warnings),
      changed: true,
    };
  });
}

export function slugify(title?: string): string {
  const slug = (title?.trim() || "link")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "link";
}

export function base58(buffer: Buffer): string {
  let value = BigInt(`0x${buffer.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of buffer) {
    if (byte === 0) encoded = BASE58[0] + encoded;
    else break;
  }
  return encoded || BASE58[0];
}

type SlugSelection = {
  slug: string;
  existing?: LinkRecord;
  collisionResolved: boolean;
};

function selectCustomSlug(
  store: Store,
  input: PreparedLinkInput,
  now: number,
): SlugSelection {
  const slug = input.slug!;
  const existing = store.links[slug];
  if (!existing) return { slug, collisionResolved: false };

  if (
    input.dedupe &&
    existing.targetUrl === input.targetUrl &&
    !isExpired(existing, now)
  ) {
    return { slug, existing, collisionResolved: false };
  }
  if (existing.targetUrl === input.targetUrl && isExpired(existing, now)) {
    throw new Error(
      `Slug already exists but is expired: ${slug}. Choose a different slug.`,
    );
  }
  if (existing.targetUrl === input.targetUrl) {
    throw new Error(`Slug already exists: ${slug}.`);
  }
  throw new Error(`Slug already exists for a different target URL: ${slug}.`);
}

function selectGeneratedSlug(
  store: Store,
  input: PreparedLinkInput,
  now: number,
): SlugSelection {
  const prefix = slugify(input.title);
  const identifier = base58(sha256(input.targetUrl));
  let collisionResolved = false;

  for (const suffixLength of [4, 5, 6, 8]) {
    const slug = withMaxSlug(prefix, identifier.slice(0, suffixLength));
    const existing = store.links[slug];
    if (!existing) return { slug, collisionResolved };
    if (
      input.dedupe &&
      existing.targetUrl === input.targetUrl &&
      !isExpired(existing, now)
    ) {
      return { slug, existing, collisionResolved };
    }
    collisionResolved = true;
  }

  for (let counter = 2; ; counter++) {
    const slug = withMaxSlug(prefix, identifier.slice(0, 8), counter);
    if (!store.links[slug]) return { slug, collisionResolved: true };
  }
}

function withMaxSlug(prefix: string, suffix: string, counter?: number): string {
  const tail = `-${suffix}${counter ? `-${counter}` : ""}`;
  const available = Math.max(1, 80 - tail.length);
  return `${prefix.slice(0, available).replace(/-$/g, "")}${tail}`;
}

function expirationDate(expiresIn: ExpiresIn, now: number): string | null {
  if (expiresIn === "never") return null;
  const duration =
    expiresIn === "1h"
      ? 60 * 60 * 1_000
      : expiresIn === "1d"
        ? 24 * 60 * 60 * 1_000
        : expiresIn === "7d"
          ? 7 * 24 * 60 * 60 * 1_000
          : 30 * 24 * 60 * 60 * 1_000;
  return new Date(now + duration).toISOString();
}

function result(
  link: LinkRecord,
  deduped: boolean,
  collisionResolved: boolean,
  warnings: string[],
): CreateLinkResult {
  return {
    link,
    deduped,
    collisionResolved,
    warnings: [...warnings],
  };
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

function hashUrl(url: string): string {
  return `sha256:${sha256(url).toString("hex")}`;
}
