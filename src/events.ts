import type { ShortLinkResult } from "./command.ts";
import type { CreateLinkInput } from "./types.ts";

export const SHORT_LINK_CREATE_EVENT = "pi-short-links:create:v1";
const EXPIRES_IN_VALUES = new Set<unknown>(["1h", "1d", "7d", "30d", "never"]);

export type ShortLinkCreateRequestV1 = {
  version: 1;
  input: {
    url: string;
    title?: string;
    description?: string;
    tags?: string[];
    expiresIn?: "1h" | "1d" | "7d" | "30d" | "never";
    dedupe?: boolean;
  };
  claim(): boolean;
  // localOnly is false when PI_SHORT_LINKS_COMMAND creates links teammates can open.
  resolve(result: ShortLinkResult): void;
  reject(error: unknown): void;
};

type EventBus = {
  on(channel: string, handler: (data: unknown) => void): () => void;
};

type ShortLinkCreator = {
  create(input: CreateLinkInput, source: "extension"): Promise<ShortLinkResult>;
};

export function registerShortLinkEventService(
  events: EventBus,
  links: ShortLinkCreator,
): () => void {
  return events.on(SHORT_LINK_CREATE_EVENT, (data) => {
    if (!isRequest(data) || !data.claim()) return;

    void (async () => {
      try {
        data.resolve(await links.create(data.input, "extension"));
      } catch (error: unknown) {
        data.reject(error);
      }
    })();
  });
}

function isRequest(value: unknown): value is ShortLinkCreateRequestV1 {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.input)) {
    return false;
  }
  const { input } = value;
  return (
    typeof input.url === "string" &&
    isOptionalString(input.title) &&
    isOptionalString(input.description) &&
    (input.tags === undefined ||
      (Array.isArray(input.tags) &&
        input.tags.every((tag) => typeof tag === "string"))) &&
    (input.expiresIn === undefined || EXPIRES_IN_VALUES.has(input.expiresIn)) &&
    (input.dedupe === undefined || typeof input.dedupe === "boolean") &&
    typeof value.claim === "function" &&
    typeof value.resolve === "function" &&
    typeof value.reject === "function"
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
