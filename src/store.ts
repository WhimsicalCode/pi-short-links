import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  STORE_VERSION,
  emptyStore,
  type LinkRecord,
  type Store,
} from "./types.ts";

type Mutation<T> = {
  value: T;
  changed: boolean;
};

type StoreOptions = {
  secureDirectory?: boolean;
};

export class JsonLinkStore {
  readonly filePath: string;
  private readonly secureDirectory: boolean;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: StoreOptions = {}) {
    this.filePath = filePath;
    this.secureDirectory = options.secureDirectory ?? false;
  }

  async read(): Promise<Store> {
    await this.mutationTail;
    return this.load();
  }

  mutate<T>(
    mutator: (store: Store) => Mutation<T> | Promise<Mutation<T>>,
  ): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      const store = await this.load();
      const mutation = await mutator(store);
      if (mutation.changed) await this.save(store);
      return mutation.value;
    });

    this.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async load(): Promise<Store> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
      if (this.secureDirectory) {
        await fs.chmod(path.dirname(this.filePath), 0o700);
      }
      await fs.chmod(this.filePath, 0o600);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return emptyStore();
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Could not read short-links store because it contains invalid JSON: ${this.filePath}.`,
      );
    }

    return validateStore(parsed, this.filePath);
  }

  private async save(store: Store): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (this.secureDirectory) await fs.chmod(directory, 0o700);

    const temporaryPath = path.join(
      directory,
      `.links-${process.pid}-${randomUUID()}.tmp`,
    );
    let renamed = false;

    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.filePath);
      renamed = true;
    } finally {
      if (!renamed) await fs.rm(temporaryPath, { force: true });
    }
  }
}

function validateStore(value: unknown, filePath: string): Store {
  if (!isRecord(value))
    return invalidStore(filePath, "top level must be an object");
  if (value.version !== STORE_VERSION) {
    throw new Error(
      `Unsupported short-links store version at ${filePath}: ${String(value.version)}.`,
    );
  }
  if (!isRecord(value.links))
    return invalidStore(filePath, "links must be an object");

  const links: Record<string, LinkRecord> = {};
  for (const [key, candidate] of Object.entries(value.links)) {
    links[key] = validateLink(candidate, key, filePath);
  }

  return { version: STORE_VERSION, links };
}

function validateLink(
  value: unknown,
  key: string,
  filePath: string,
): LinkRecord {
  if (!isRecord(value))
    return invalidStore(filePath, `link ${key} must be an object`);

  const requiredStrings = [
    "id",
    "slug",
    "targetUrl",
    "targetUrlHash",
    "createdAt",
    "updatedAt",
    "source",
  ] as const;
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string") {
      return invalidStore(filePath, `link ${key}.${field} must be a string`);
    }
  }

  if (value.id !== key || value.slug !== key) {
    return invalidStore(filePath, `link ${key} must match its id and slug`);
  }
  if (!isHttpUrl(value.targetUrl as string)) {
    return invalidStore(
      filePath,
      `link ${key}.targetUrl must be an absolute http(s) URL`,
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(value.targetUrlHash as string)) {
    return invalidStore(filePath, `link ${key}.targetUrlHash is invalid`);
  }
  if (!isNullableString(value.title) || !isNullableString(value.description)) {
    return invalidStore(filePath, `link ${key} has invalid text metadata`);
  }
  if (
    !Array.isArray(value.tags) ||
    value.tags.some((tag) => typeof tag !== "string")
  ) {
    return invalidStore(
      filePath,
      `link ${key}.tags must be an array of strings`,
    );
  }
  if (!isDateString(value.createdAt) || !isDateString(value.updatedAt)) {
    return invalidStore(filePath, `link ${key} has an invalid timestamp`);
  }
  if (
    !isNullableDateString(value.expiresAt) ||
    !isNullableDateString(value.lastAccessedAt)
  ) {
    return invalidStore(
      filePath,
      `link ${key} has an invalid optional timestamp`,
    );
  }
  if (
    !Number.isInteger(value.accessCount) ||
    (value.accessCount as number) < 0
  ) {
    return invalidStore(
      filePath,
      `link ${key}.accessCount must be a non-negative integer`,
    );
  }
  if (!isRecord(value.metadata)) {
    return invalidStore(filePath, `link ${key}.metadata must be an object`);
  }

  return value as LinkRecord;
}

function invalidStore(filePath: string, reason: string): never {
  throw new Error(
    `Could not read short-links store because it has an invalid v1 structure: ${filePath} (${reason}).`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableDateString(value: unknown): value is string | null {
  return value === null || isDateString(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
