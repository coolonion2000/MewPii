/** Watch Pi resource locations, including directories created after startup. @author coolonion */
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";

export class ResourceWatch {
  private watchers: FSWatcher[] = [];
  private debounce?: NodeJS.Timeout;
  private closed = false;
  constructor(private roots: string[], private files: string[], private changed: () => void) {
    this.install();
  }
  private install(): void {
    if (this.closed) return;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    const installed = new Map<string, Array<(name: string) => boolean>>();
    const attach = (path: string, recursive: boolean, relevant: (name: string) => boolean) => {
      const key = `${path}:${recursive}`;
      const existing = installed.get(key);
      if (existing) { existing.push(relevant); return; }
      const predicates = [relevant];
      try {
        const watcher = watch(path, { recursive, persistent: false }, (_event, name) => {
          if (name && !predicates.some(predicate => predicate(String(name)))) return;
          clearTimeout(this.debounce);
          this.debounce = setTimeout(() => {
            // Re-arm watches after atomic saves, new directories and package replacement.
            this.install();
            this.changed();
          }, 500);
          this.debounce.unref();
        });
        watcher.on("error", () => { watcher.close(); });
        this.watchers.push(watcher);
        installed.set(key, predicates);
      } catch { /* Missing paths are watched through their existing parents. */ }
    };
    const resourceNames = new Set(["settings.json", "extensions", "skills", "prompts", "themes"]);
    for (const root of this.roots) {
      attach(dirname(root), false, name => name === basename(root));
      attach(root, false, name => resourceNames.has(name));
      for (const name of ["extensions", "skills", "prompts", "themes"])
        attach(join(root, name), true, path => !path.split(/[\\/]/).some(part => part === ".git" || part === "node_modules")
          && !/\.(swp|tmp|log)$/.test(path));
    }
    // Package entry points may live outside the conventional resource directories.
    for (const file of this.files) {
      attach(dirname(file), false, name => name === basename(file));
      attach(file, false, () => true);
    }
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.debounce);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
