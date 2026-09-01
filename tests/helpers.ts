import { createHash } from "node:crypto";
import type { LinkRecord } from "../src/types.ts";

export function makeLink(
  slug: string,
  targetUrl = `https://example.com/${slug}`,
  overrides: Partial<LinkRecord> = {},
): LinkRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id: slug,
    slug,
    targetUrl,
    targetUrlHash: `sha256:${createHash("sha256").update(targetUrl).digest("hex")}`,
    title: null,
    description: null,
    tags: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: null,
    lastAccessedAt: null,
    accessCount: 0,
    source: "test",
    metadata: {},
    ...overrides,
  };
}
