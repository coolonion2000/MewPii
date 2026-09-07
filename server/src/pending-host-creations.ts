/** Bounded ownership of session paths published before host creation completes. @author coolonion */
import { resolve } from "node:path";
import type { SessionSnapshot } from "./protocol.js";

export type HostPreviewListener = (snapshot: SessionSnapshot) => void | Promise<void>;

interface PendingHost<T> {
  cwd: string;
  promise: Promise<T>;
  latest?: SessionSnapshot;
  initialPath?: string;
  previewPath?: string;
  listeners: Set<HostPreviewListener>;
}

export class PendingHostCreations<T> {
  private active = new Map<string, PendingHost<T>>();
  private paths = new Map<string, PendingHost<T>>();

  // At most two path aliases per creation (requested + latest preview), and
  // bounded live viewers even if an extension never finishes initializing.
  constructor(private readonly capacity = 128, private readonly listenerCapacity = 128) {}

  get size(): number { return this.active.size; }
  values(): Promise<T>[] { return [...this.active.values()].map((entry) => entry.promise); }
  get(path: string): PendingHost<T> | undefined { return this.paths.get(resolve(path)); }
  previewForSessionId(id: string): SessionSnapshot | undefined {
    return [...this.active.values()].find((entry) => entry.latest?.sessionId === id)?.latest;
  }

  async join(entry: PendingHost<T>, listener?: HostPreviewListener, signal?: AbortSignal): Promise<T> {
    if (listener && !signal?.aborted && entry.listeners.size >= this.listenerCapacity)
      throw new Error("too many session initialization viewers");
    const remove = () => { if (listener) entry.listeners.delete(listener); };
    if (listener && !signal?.aborted) {
      entry.listeners.add(listener);
      signal?.addEventListener("abort", remove, { once: true });
    }
    try {
      if (listener && !signal?.aborted && entry.latest) {
        // Preview delivery must not hide the authoritative creation outcome.
        await Promise.resolve().then(() => listener(entry.latest!)).catch(() => undefined);
      }
      return await entry.promise;
    } finally {
      remove();
      signal?.removeEventListener("abort", remove);
    }
  }

  start(
    key: string,
    cwd: string,
    initialPath: string | undefined,
    create: (publish: HostPreviewListener) => Promise<T>,
    listener?: HostPreviewListener,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.active.size >= this.capacity) throw new Error("too many initializing sessions");
    if (this.active.has(key) || (initialPath && this.get(initialPath)))
      throw new Error("session creation already pending");
    const entry: PendingHost<T> = {
      cwd,
      initialPath: initialPath ? resolve(initialPath) : undefined,
      listeners: new Set(),
      // Defer create until ownership and the shared promise are both installed.
      promise: Promise.resolve().then(async () => {
        let status = "failed";
        try {
          const host = await create(async (snapshot) => {
            const path = snapshot.sessionFile ? resolve(snapshot.sessionFile) : undefined;
            if (path) {
              const owner = this.paths.get(path);
              if (owner && owner !== entry) throw new Error("session preview path already owned");
            }
            if (entry.previewPath && entry.previewPath !== entry.initialPath)
              this.paths.delete(entry.previewPath);
            entry.previewPath = path;
            if (path) this.paths.set(path, entry);
            entry.latest = snapshot;
            await Promise.allSettled([...entry.listeners].map((notify) =>
              Promise.resolve().then(() => notify(snapshot)),
            ));
          });
          status = "ready";
          return host;
        } finally {
          this.active.delete(key);
          for (const path of [entry.initialPath, entry.previewPath]) {
            if (path && this.paths.get(path) === entry) this.paths.delete(path);
          }
          const viewers = entry.listeners.size;
          entry.listeners.clear();
          process.stdout.write(
            `[session] creation_settled status=${status} session_id=${JSON.stringify(entry.latest?.sessionId ?? "")} viewers=${viewers} pending=${this.size}\n`,
          );
        }
      }),
    };
    this.active.set(key, entry);
    if (entry.initialPath) this.paths.set(entry.initialPath, entry);
    return this.join(entry, listener, signal);
  }
}
