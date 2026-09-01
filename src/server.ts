import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { JsonLinkStore } from "./store.ts";
import { isExpired, type Store } from "./types.ts";

export type RedirectServerConfig = {
  host: "127.0.0.1";
  portStart: number;
  portEnd: number;
};

export type RunningServer = {
  host: "127.0.0.1";
  port: number;
  started: true;
};

export type ServerStatus = {
  running: boolean;
  host: "127.0.0.1";
  port: number | null;
};

type RedirectOutcome =
  | { kind: "missing" }
  | { kind: "expired" }
  | { kind: "redirect"; targetUrl: string };

export class RedirectServer {
  private readonly config: RedirectServerConfig;
  private readonly store: JsonLinkStore;
  private server: Server | null = null;
  private port: number | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();

  constructor(config: RedirectServerConfig, store: JsonLinkStore) {
    this.config = config;
    this.store = store;
  }

  start(): Promise<RunningServer> {
    return this.enqueueLifecycle(async () => {
      if (this.server?.listening && this.port !== null) {
        return { host: this.config.host, port: this.port, started: true };
      }

      for (
        let candidatePort = this.config.portStart;
        candidatePort <= this.config.portEnd;
        candidatePort++
      ) {
        try {
          const candidate = await this.listen(candidatePort);
          const address = candidate.address() as AddressInfo;
          this.server = candidate;
          this.port = address.port;
          return {
            host: this.config.host,
            port: address.port,
            started: true,
          };
        } catch (error: unknown) {
          const code = errorCode(error);
          if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
        }
      }

      throw new Error(
        `Could not start short-links server: no available port in ${this.config.portStart}-${this.config.portEnd}.`,
      );
    });
  }

  stop(): Promise<boolean> {
    return this.enqueueLifecycle(async () => {
      const candidate = this.server;
      this.server = null;
      this.port = null;
      if (!candidate) return false;

      const closed = new Promise<void>((resolve, reject) => {
        candidate.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      candidate.closeAllConnections?.();
      await closed;
      return true;
    });
  }

  status(): ServerStatus {
    return {
      running: this.server?.listening === true && this.port !== null,
      host: this.config.host,
      port: this.port,
    };
  }

  urlFor(slug: string): string | null {
    if (!this.status().running || this.port === null) return null;
    return `http://${this.config.host}:${this.port}/s/${encodeURIComponent(slug)}`;
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private listen(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      const candidate = createServer((request, response) => {
        this.handle(request, response).catch((error: unknown) => {
          if (!response.headersSent) {
            writeText(response, 500, "Internal Server Error");
          } else {
            response.destroy();
          }
          console.error("short-links server error", errorMessage(error));
        });
      });

      candidate.requestTimeout = 15_000;
      candidate.headersTimeout = 10_000;
      candidate.keepAliveTimeout = 5_000;

      const onError = (error: Error) => {
        candidate.removeListener("listening", onListening);
        candidate.close();
        reject(error);
      };
      const onListening = () => {
        candidate.removeListener("error", onError);
        candidate.on("error", (error) => {
          console.error("short-links server error", error.message);
        });
        resolve(candidate);
      };

      candidate.once("error", onError);
      candidate.once("listening", onListening);
      candidate.listen(port, this.config.host);
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      writeText(response, 405, "Method Not Allowed");
      return;
    }

    let requestUrl: URL;
    try {
      requestUrl = new URL(
        request.url ?? "/",
        `http://${this.config.host}:${this.port ?? this.config.portStart}`,
      );
    } catch {
      writeText(response, 400, "Bad Request");
      return;
    }

    if (requestUrl.pathname === "/healthz") {
      const store = await this.store.read();
      writeJson(response, 200, {
        ok: true,
        links: Object.keys(store.links).length,
        host: this.config.host,
        port: this.port,
      });
      return;
    }

    if (requestUrl.pathname === "/") {
      const store = await this.store.read();
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'",
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(indexHtml(store, this.config.host, this.port));
      return;
    }

    const match = requestUrl.pathname.match(/^\/s\/([^/]+)$/);
    if (!match) {
      writeText(response, 404, "Not Found");
      return;
    }

    let slug: string;
    try {
      slug = decodeURIComponent(match[1]);
    } catch {
      writeText(response, 404, "Not Found");
      return;
    }

    const outcome = await this.store.mutate<RedirectOutcome>((store) => {
      const link = store.links[slug];
      if (!link) return { value: { kind: "missing" } as const, changed: false };
      if (isExpired(link)) {
        return { value: { kind: "expired" } as const, changed: false };
      }

      link.accessCount += 1;
      link.lastAccessedAt = new Date().toISOString();
      link.updatedAt = link.lastAccessedAt;
      return {
        value: { kind: "redirect", targetUrl: link.targetUrl } as const,
        changed: true,
      };
    });

    if (outcome.kind === "missing") {
      writeText(response, 404, "Not Found");
      return;
    }
    if (outcome.kind === "expired") {
      writeText(response, 410, "Gone");
      return;
    }

    response.writeHead(302, {
      "cache-control": "no-store",
      location: outcome.targetUrl,
      "x-content-type-options": "nosniff",
    });
    response.end();
  }
}

function indexHtml(store: Store, host: string, port: number | null): string {
  const rows = Object.values(store.links)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((link) => {
      const href = `/s/${encodeURIComponent(link.slug)}`;
      const shortUrl = `http://${host}:${port ?? ""}${href}`;
      const expiry = link.expiresAt
        ? isExpired(link)
          ? "expired"
          : link.expiresAt
        : "never";
      return `<tr><td>${escapeHtml(link.title || link.slug)}</td><td><a href="${href}">${escapeHtml(shortUrl)}</a></td><td>${escapeHtml(link.createdAt)}</td><td>${escapeHtml(expiry)}</td></tr>`;
    })
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pi short links</title></head><body><main><h1>Pi short links</h1><p>These links work only on this machine while Pi's short-links server is running. Targets are hidden.</p><table><thead><tr><th>Title</th><th>Short URL</th><th>Created</th><th>Expires</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
      })[character]!,
  );
}

function writeText(
  response: ServerResponse,
  status: number,
  text: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
