import { spawn } from "node:child_process";
import { prepareLinkInput } from "./links.ts";
import type { CreateLinkInput } from "./types.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;

export type ShortLinkResult = {
  shortUrl: string;
  localOnly: boolean;
  warnings: string[];
};

export type CommandConfig = {
  command: string;
  timeoutMs: number;
};

/**
 * Delegates link creation to a user-configured shell command, so links can live in a
 * store and on a domain that teammates can reach. The command gets a JSON payload on
 * stdin and prints the short URL as the last line of stdout.
 */
export class CommandLinkService {
  private readonly config: CommandConfig;

  constructor(config: CommandConfig) {
    this.config = config;
  }

  async create(input: CreateLinkInput): Promise<ShortLinkResult> {
    const prepared = prepareLinkInput(input);
    const payload = {
      version: 1,
      url: prepared.targetUrl,
      title: prepared.title ?? null,
      description: prepared.description ?? null,
      tags: prepared.tags,
      slug: prepared.slug ?? null,
      expiresIn: prepared.expiresIn,
    };
    const stdout = await runCommand(
      this.config,
      `${JSON.stringify(payload)}\n`,
    );
    return {
      shortUrl: parseShortUrl(stdout),
      localOnly: false,
      warnings: prepared.warnings,
    };
  }
}

export function parseShortUrl(stdout: string): string {
  const line = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
  let url: URL;
  try {
    url = new URL(line);
  } catch {
    throw new Error(
      "Short-link command must print an absolute http(s) URL as its last line of output.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "Short-link command must print an absolute http(s) URL as its last line of output.",
    );
  }
  return line;
}

function runCommand(config: CommandConfig, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", config.command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        new Error(`Short-link command timed out after ${config.timeoutMs} ms.`),
      );
    }, config.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = capped(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = capped(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) =>
      finish(new Error(`Short-link command could not start: ${error.message}`)),
    );
    child.on("close", (code) => {
      if (code === 0) {
        finish(null);
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).pop();
      finish(
        new Error(
          `Short-link command failed with exit code ${String(code)}${detail ? `: ${detail}` : "."}`,
        ),
      );
    });

    child.stdin.on("error", () => {
      // The command may exit without reading stdin; its exit code is reported above.
    });
    child.stdin.end(stdin);
  });
}

function capped(value: string): string {
  return value.length > MAX_OUTPUT_BYTES
    ? value.slice(value.length - MAX_OUTPUT_BYTES)
    : value;
}
