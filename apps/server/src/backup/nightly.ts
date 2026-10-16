import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/connection.ts';

const FILE_RE = /^tavern-(\d{4}-\d{2}-\d{2})\.db$/;

export interface NightlyBackupOptions {
  db: Db;
  dir: string;
  keepDays?: number;
  now?: () => Date;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * One SQLite online backup per day (`tavern-YYYY-MM-DD.db`, UTC) in `dir`, keeping the last
 * `keepDays`. The online backup API copies a consistent database while the game keeps running.
 * Checked hourly, so a server that was off at night still backs up soon after it starts.
 */
export class NightlyBackups {
  private readonly o: Required<NightlyBackupOptions>;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<string | null> | null = null;

  constructor(opts: NightlyBackupOptions) {
    this.o = { keepDays: 14, now: () => new Date(), log: () => {}, ...opts };
  }

  start() {
    void this.runIfDue();
    this.timer = setInterval(() => void this.runIfDue(), 60 * 60 * 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): { file: string; date: string; bytes: number }[] {
    try {
      return readdirSync(this.o.dir)
        .map((f) => ({ f, m: FILE_RE.exec(f) }))
        .filter((x): x is { f: string; m: RegExpExecArray } => !!x.m)
        .map(({ f, m }) => ({ file: join(this.o.dir, f), date: m[1]!, bytes: statSync(join(this.o.dir, f)).size }))
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch {
      return [];
    }
  }

  /** Writes today's backup if it does not exist yet, then prunes. Returns the new file, if any. */
  runIfDue(): Promise<string | null> {
    this.running ??= this.backup().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async backup(): Promise<string | null> {
    const today = this.o.now().toISOString().slice(0, 10);
    mkdirSync(this.o.dir, { recursive: true });
    const file = join(this.o.dir, `tavern-${today}.db`);
    let made: string | null = null;
    if (!this.list().some((b) => b.date === today)) {
      try {
        await this.o.db.$client.backup(`${file}.partial`);
        // Rename only when complete, so a crash never leaves a half-written "good" backup.
        renameSync(`${file}.partial`, file);
        made = file;
        this.o.log(`backup written: ${file}`);
      } catch (err) {
        rmSync(`${file}.partial`, { force: true });
        this.o.log('backup failed', err);
        return null;
      }
    }
    this.prune(today);
    return made;
  }

  private prune(today: string) {
    const cutoff = new Date(`${today}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - (this.o.keepDays - 1));
    const keepFrom = cutoff.toISOString().slice(0, 10);
    for (const b of this.list()) if (b.date < keepFrom) rmSync(b.file, { force: true });
  }
}
