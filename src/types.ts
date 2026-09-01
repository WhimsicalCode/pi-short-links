export const STORE_VERSION = 1 as const;

export type LinkRecord = {
  id: string;
  slug: string;
  targetUrl: string;
  targetUrlHash: string;
  title: string | null;
  description: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  source: string;
  metadata: Record<string, unknown>;
};

export type Store = {
  version: typeof STORE_VERSION;
  links: Record<string, LinkRecord>;
};

export type ExpiresIn = "1h" | "1d" | "7d" | "30d" | "never";

export type CreateLinkInput = {
  url: string;
  title?: string;
  description?: string;
  tags?: string[];
  slug?: string;
  expiresIn?: ExpiresIn;
  dedupe?: boolean;
};

export type CreateLinkResult = {
  link: LinkRecord;
  deduped: boolean;
  collisionResolved: boolean;
  warnings: string[];
};

export function emptyStore(): Store {
  return { version: STORE_VERSION, links: {} };
}

export function isExpired(
  link: Pick<LinkRecord, "expiresAt">,
  now = Date.now(),
): boolean {
  return link.expiresAt !== null && Date.parse(link.expiresAt) <= now;
}
