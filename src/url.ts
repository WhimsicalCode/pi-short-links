import { BlockList, isIP } from "node:net";

const PRIVATE_ADDRESSES = new BlockList();
PRIVATE_ADDRESSES.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE_ADDRESSES.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_ADDRESSES.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_ADDRESSES.addAddress("::1", "ipv6");
PRIVATE_ADDRESSES.addSubnet("fc00::", 7, "ipv6");
PRIVATE_ADDRESSES.addSubnet("fe80::", 10, "ipv6");

const SUSPICIOUS_PARAMETER_NAMES = new Set([
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "api_key",
  "apikey",
  "key",
  "session",
  "auth",
  "signature",
]);

export type ValidatedUrl = {
  url: string;
  warnings: string[];
};

export function validateUrl(input: string): ValidatedUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Invalid URL: expected an absolute http(s) URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid URL: expected an absolute http(s) URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported URL scheme: ${parsed.protocol}. Only http and https are supported.`,
    );
  }

  const warnings: string[] = [];
  const suspiciousNames = findSuspiciousParameterNames(parsed);
  if (suspiciousNames.length > 0) {
    warnings.push(
      `target URL contains parameter names that may carry secrets: ${suspiciousNames.join(", ")}.`,
    );
  }
  if (isPrivateHost(parsed.hostname)) {
    warnings.push(
      "target URL points to localhost/private network and will only work in that local context.",
    );
  }

  return { url: parsed.href, warnings };
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") {
    return true;
  }

  const family = isIP(host);
  if (family === 4) return PRIVATE_ADDRESSES.check(host, "ipv4");
  if (family === 6) return PRIVATE_ADDRESSES.check(host, "ipv6");
  return false;
}

function findSuspiciousParameterNames(url: URL): string[] {
  const found = new Set<string>();

  for (const key of url.searchParams.keys()) {
    addIfSuspicious(found, key);
  }

  const fragment = url.hash.slice(1);
  const parameterPattern = /(?:^|[?&#])([^=?&#]+)(?==)/g;
  let match: RegExpExecArray | null;
  while ((match = parameterPattern.exec(fragment))) {
    addIfSuspicious(found, safeDecode(match[1].replace(/\+/g, " ")));
  }

  return [...found].sort();
}

function addIfSuspicious(found: Set<string>, name: string): void {
  const normalized = name.toLowerCase();
  if (SUSPICIOUS_PARAMETER_NAMES.has(normalized)) found.add(normalized);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
