/** Detect live pi-subagents work owned by one parent session. @author coolonion */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

interface SubagentStatus {
  sessionId?: string;
  state?: string;
  pid?: number;
  deadlineAt?: number;
}

export interface SubagentActivityOptions {
  tempRoot?: string;
  now?: number;
  pidAlive?: (pid: number) => boolean;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True while a queued/running async run still belongs to this session. */
export function hasRunningSubagentRuns(
  parentSessionFile: string | undefined,
  options: SubagentActivityOptions = {},
): boolean {
  if (!parentSessionFile) return false;
  const parent = resolve(parentSessionFile);
  const root = options.tempRoot ?? tmpdir();
  const now = options.now ?? Date.now();
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  let scopes: string[];
  try {
    scopes = readdirSync(root).filter((name) =>
      name.startsWith("pi-subagents-"),
    );
  } catch {
    return false;
  }

  for (const scope of scopes) {
    const runsRoot = join(root, scope, "async-subagent-runs");
    let runIds: string[];
    try {
      runIds = readdirSync(runsRoot);
    } catch {
      continue;
    }
    for (const runId of runIds) {
      try {
        const status = JSON.parse(
          readFileSync(join(runsRoot, runId, "status.json"), "utf8"),
        ) as SubagentStatus;
        if (!status.sessionId || resolve(status.sessionId) !== parent) continue;
        if (status.state !== "queued" && status.state !== "running") continue;
        // A run cannot remain a keepalive lease forever after its hard deadline.
        if (
          typeof status.deadlineAt === "number" &&
          now > status.deadlineAt + 60_000
        )
          continue;
        if (typeof status.pid === "number" && !pidAlive(status.pid)) continue;
        return true;
      } catch {
        // Ignore incomplete or concurrently replaced status files.
      }
    }
  }
  return false;
}
