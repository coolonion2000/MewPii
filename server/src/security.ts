/**
 * Security-boundary helpers shared by the HTTP handlers and regression tests.
 * @author coolonion
 */
import type { IncomingMessage } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
  delimiter,
} from "node:path";

export function createFlowCapability(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: createHash("sha256").update(secret).digest("hex") };
}

export function flowCapabilityMatches(
  secret: unknown,
  expectedHash: string,
): boolean {
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    !/^[A-Za-z0-9_-]+$/.test(secret)
  )
    return false;
  const actual = createHash("sha256").update(secret).digest();
  const expected = Buffer.from(expectedHash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function safeNextPath(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  )
    return "/";
  try {
    const parsed = new URL(value, "http://mewpii.invalid");
    return parsed.origin === "http://mewpii.invalid"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : "/";
  } catch {
    return "/";
  }
}

function originMatchesRequest(
  origin: string,
  req: Pick<IncomingMessage, "headers" | "socket">,
): boolean {
  if (origin === "null") return false;
  try {
    const parsed = new URL(origin);
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
      .split(",")[0]
      .trim();
    const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "")
      .split(",")[0]
      .trim();
    const encrypted = Boolean((req.socket as { encrypted?: boolean }).encrypted);
    const protocol = forwardedProto || (encrypted ? "https" : "http");
    return parsed.host === host && parsed.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}

/** Browser WebSocket Origin must match both externally visible scheme and host. */
export function webSocketOriginAllowed(
  req: Pick<IncomingMessage, "headers" | "socket">,
): boolean {
  const origin = req.headers.origin;
  return origin === undefined || originMatchesRequest(origin, req);
}

/** Reject browser cross-site mutations while retaining curl/CLI and tunnel-agent requests. */
export function mutationRequestAllowed(
  req: Pick<IncomingMessage, "method" | "headers" | "socket">,
): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS")
    return true;

  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite === "cross-site" || fetchSite === "none") return false;

  const origin = req.headers.origin;
  if (!origin) return fetchSite === undefined || fetchSite === "same-origin";
  return originMatchesRequest(origin, req);
}

function inside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

export function configuredWorkspaceRoots(): string[] {
  const configured = (process.env.PII_WORKSPACE_ROOTS ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured.map((p) => resolve(p));
  return [resolve(process.env.HOME ?? process.cwd()), resolve(process.cwd())];
}

export async function canonicalRoots(
  extraRoots: readonly string[] = [],
): Promise<string[]> {
  const roots = [...configuredWorkspaceRoots(), ...extraRoots];
  const canonical = await Promise.all(
    roots.map(async (root) => realpath(root).catch(() => undefined)),
  );
  return [
    ...new Set(canonical.filter((root): root is string => Boolean(root))),
  ];
}

export async function resolveWorkspacePath(
  cwd: string,
  target: string,
  options: { write?: boolean; extraRoots?: readonly string[] } = {},
): Promise<{ base: string; path: string }> {
  if (!isAbsolute(cwd)) throw new Error("workspace must be an absolute path");
  const base = await realpath(resolve(cwd));
  if (!(await stat(base)).isDirectory())
    throw new Error("workspace is not a directory");
  const roots = await canonicalRoots(options.extraRoots);
  if (!roots.some((root) => inside(root, base)))
    throw new Error("workspace is not trusted");

  const candidate = resolve(base, target);
  if (!inside(base, candidate)) throw new Error("path escapes workspace");

  if (!options.write || existsSync(candidate)) {
    const canonical = await realpath(candidate);
    if (!inside(base, canonical)) throw new Error("symlink escapes workspace");
    return { base, path: canonical };
  }

  let ancestor = dirname(candidate);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("no writable ancestor");
    ancestor = parent;
  }
  const canonicalAncestor = await realpath(ancestor);
  if (!inside(base, canonicalAncestor))
    throw new Error("symlink escapes workspace");
  return { base, path: candidate };
}
