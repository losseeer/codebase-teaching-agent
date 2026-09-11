import { watch, type FSWatcher } from "node:fs";
import { createTutorIgnoreMatcher, isTutorIgnoreFile } from "./ignore.js";

export class RepositoryWatcher {
  private watcher?: FSWatcher;
  private readonly pending = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly repositoryPath: string, private readonly onChange: (paths: string[]) => void, private readonly debounceMs = 450) {}

  start(): void {
    try {
      let ignore = createTutorIgnoreMatcher(this.repositoryPath);
      this.watcher = watch(this.repositoryPath, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const path = String(filename).replaceAll("\\", "/");
        if (isTutorIgnoreFile(path)) ignore = createTutorIgnoreMatcher(this.repositoryPath);
        if (!isTutorIgnoreFile(path) && ignore.ignores(path)) return;
        this.pending.add(path);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const changed = [...this.pending].filter(Boolean);
          this.pending.clear();
          if (changed.length) this.onChange(changed);
        }, this.debounceMs);
      });
    } catch {
      // Watching is an enhancement; imports remain usable on filesystems without recursive watch support.
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
  }
}
