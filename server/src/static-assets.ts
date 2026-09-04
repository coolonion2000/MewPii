import { existsSync } from "node:fs";
import { extname, isAbsolute, relative, sep } from "node:path";

export type StaticContentEncoding = "br" | "gzip";

export interface StaticRepresentation {
  path: string;
  encoding?: StaticContentEncoding;
  varyAcceptEncoding: boolean;
  notAcceptable?: boolean;
}

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".svg",
]);

function acceptedQuality(
  header: string,
  encoding: StaticContentEncoding | "identity",
  defaultQuality = 0,
): number {
  let wildcard: number | undefined;
  for (const part of header.toLowerCase().split(",")) {
    const [rawName, ...parameters] = part.trim().split(";");
    if (!rawName) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const value = parameter.trim();
      if (!/^q\s*=/.test(value)) continue;
      const match = /^q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(value);
      quality = match ? Number(match[1]) : 0;
    }
    if (rawName === encoding) return quality;
    if (rawName === "*") wildcard = quality;
  }
  return wildcard ?? defaultQuality;
}

/** A resolved candidate is contained by root, not merely sharing its prefix. */
export function isPathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}

/** Select a pre-compressed build artifact without spending CPU in the request path. */
export function selectStaticRepresentation(
  path: string,
  acceptEncoding: string | string[] | undefined,
): StaticRepresentation {
  const header = Array.isArray(acceptEncoding)
    ? acceptEncoding.join(",")
    : (acceptEncoding ?? "");
  if (!COMPRESSIBLE_EXTENSIONS.has(extname(path).toLowerCase())) {
    const notAcceptable = acceptedQuality(header, "identity", 1) <= 0;
    return {
      path,
      varyAcceptEncoding: notAcceptable,
      ...(notAcceptable ? { notAcceptable: true } : {}),
    };
  }
  const candidates = [
    { encoding: "br" as const, quality: acceptedQuality(header, "br") },
    { encoding: "gzip" as const, quality: acceptedQuality(header, "gzip") },
  ].sort((left, right) => right.quality - left.quality);
  for (const candidate of candidates) {
    const encodedPath = `${path}.${candidate.encoding === "gzip" ? "gz" : candidate.encoding}`;
    if (candidate.quality > 0 && existsSync(encodedPath)) {
      return {
        path: encodedPath,
        encoding: candidate.encoding,
        varyAcceptEncoding: true,
      };
    }
  }
  return {
    path,
    varyAcceptEncoding: true,
    notAcceptable: acceptedQuality(header, "identity", 1) <= 0,
  };
}
