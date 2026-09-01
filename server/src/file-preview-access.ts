/** Exact-file authorization derived from successful session tool calls. @author coolonion */
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

interface MessageLike {
  role?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  content?: unknown;
}

interface ToolCallLike {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

const FILE_TOOL_NAMES = new Set(["read", "write", "edit"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolArguments(value: unknown): Record<string, unknown> | undefined {
  const direct = record(value);
  if (direct) return direct;
  if (typeof value !== "string") return undefined;
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function toolPath(call: ToolCallLike): string | undefined {
  if (
    call.type !== "toolCall" ||
    typeof call.id !== "string" ||
    typeof call.name !== "string" ||
    !FILE_TOOL_NAMES.has(call.name)
  )
    return undefined;
  const args = toolArguments(call.arguments);
  const candidate = args?.path ?? args?.file_path;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

/** Return only paths whose matching read/write/edit tool result succeeded. */
export function successfulFileToolPaths(
  messages: readonly MessageLike[],
): string[] {
  const successfulCallIds = new Set<string>();
  for (const message of messages) {
    if (
      message.role === "toolResult" &&
      typeof message.toolCallId === "string" &&
      message.isError !== true
    )
      successfulCallIds.add(message.toolCallId);
  }

  const paths = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue;
    for (const value of message.content) {
      const block = record(value) as ToolCallLike | undefined;
      if (!block || typeof block.id !== "string") continue;
      if (!successfulCallIds.has(block.id)) continue;
      const path = toolPath(block);
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

async function canonicalFile(path: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an exact preview target only when this session already completed a
 * successful file tool call for the same canonical file.
 */
export async function resolveToolAuthorizedPreviewPath(
  cwd: string,
  target: string,
  messages: readonly MessageLike[],
): Promise<string | undefined> {
  const requested = await canonicalFile(resolve(cwd, target));
  if (!requested) return undefined;
  for (const allowed of successfulFileToolPaths(messages)) {
    const canonicalAllowed = await canonicalFile(resolve(cwd, allowed));
    if (canonicalAllowed === requested) return requested;
  }
  return undefined;
}
