import { homedir } from "node:os";
import path from "node:path";
import type { CommandConfig } from "./command.ts";
import type { RedirectServerConfig } from "./server.ts";

const DEFAULT_STORE = "~/.pi/agent/short-links/links.json";
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export type ShortLinksConfig = {
  server: RedirectServerConfig;
  storePath: string;
  secureStoreDirectory: boolean;
  command: CommandConfig | null;
};

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ShortLinksConfig {
  const configuredHost = environment.PI_SHORT_LINKS_HOST;
  if (configuredHost && configuredHost !== "127.0.0.1") {
    throw new Error("Invalid PI_SHORT_LINKS_HOST: v1 binds only to 127.0.0.1.");
  }

  const portStart = parsePort(
    "PI_SHORT_LINKS_PORT",
    environment.PI_SHORT_LINKS_PORT,
    8765,
  );
  const portEnd = parsePort(
    "PI_SHORT_LINKS_PORT_END",
    environment.PI_SHORT_LINKS_PORT_END,
    8799,
  );
  if (portEnd < portStart) {
    throw new Error(
      "Invalid short-links port range: PI_SHORT_LINKS_PORT_END must be greater than or equal to PI_SHORT_LINKS_PORT.",
    );
  }

  const configuredStore = environment.PI_SHORT_LINKS_STORE;
  if (configuredStore !== undefined && !configuredStore.trim()) {
    throw new Error("Invalid PI_SHORT_LINKS_STORE: path must not be empty.");
  }

  return {
    server: { host: "127.0.0.1", portStart, portEnd },
    storePath: expandHome(configuredStore ?? DEFAULT_STORE),
    secureStoreDirectory: configuredStore === undefined,
    command: loadCommandConfig(environment),
  };
}

function loadCommandConfig(
  environment: NodeJS.ProcessEnv,
): CommandConfig | null {
  const command = environment.PI_SHORT_LINKS_COMMAND;
  if (command === undefined) return null;
  if (!command.trim()) {
    throw new Error(
      "Invalid PI_SHORT_LINKS_COMMAND: command must not be empty.",
    );
  }

  const rawTimeout = environment.PI_SHORT_LINKS_COMMAND_TIMEOUT_MS;
  if (rawTimeout === undefined) {
    return { command, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS };
  }
  if (!/^\d+$/.test(rawTimeout) || Number(rawTimeout) < 1) {
    throw new Error(
      "Invalid PI_SHORT_LINKS_COMMAND_TIMEOUT_MS: expected a positive integer.",
    );
  }
  return { command, timeoutMs: Number(rawTimeout) };
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

function parsePort(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${name}: expected an integer from 1 to 65535.`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${name}: expected an integer from 1 to 65535.`);
  }
  return port;
}
