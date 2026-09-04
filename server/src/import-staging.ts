import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

function isMissingFile(cause: unknown): boolean {
  return Boolean(
    cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "ENOENT",
  );
}

/**
 * Give the SDK a private, unique upload path only for the duration of import.
 * The SDK copies accepted sessions into its canonical session directory, so
 * retaining this source would only leak disk space and a duplicate transcript.
 */
export async function withStagedSessionImport<T>(
  directory: string,
  content: Uint8Array,
  operation: (path: string) => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(
    directory,
    `import-${Date.now()}-${randomUUID()}.jsonl`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(path, "wx", 0o600);
    created = true;
    // Apply the exact private mode even under an unusually restrictive umask.
    await handle.chmod(0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return await operation(path);
  } finally {
    await handle?.close().catch(() => undefined);
    if (created) {
      try {
        await unlink(path);
      } catch (cause) {
        if (!isMissingFile(cause)) throw cause;
      }
    }
  }
}
