import { execFileSync, type ChildProcess } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * **The browsers and profile directories this suite creates, and the sweep that reclaims the ones a dead run left (D75).**
 *
 * A run owns two things that outlive a crashed process: a Chrome listening on a loopback port, and a profile directory of a few tens of megabytes. Each run
 * writes its own pid into the profile it makes (`OWNER_FILE`), so "whose is this" is a fact on disk rather than a guess from a name. A profile is only ever
 * touched when it is a direct child of the temp directory, a real directory, and named `qb-adversarial-*` — the one prefix this repository creates. A
 * developer's own browser, or a profile some other tool left in the same directory, is not matched and is never signalled.
 *
 * A process that is not matched is not reported as clean; it is not looked at.
 */
export const PROFILE_PREFIX = 'qb-adversarial-';
export const OWNER_FILE = '.qb-owner';

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export interface SweepDeps {
  readonly tmp: string;
  processes(): ProcessRow[];
  isAlive(pid: number): boolean;
  kill(pid: number): void;
}

export interface SweepReport {
  /** Profiles whose owning run is alive: reported, never touched. */
  readonly inUse: string[];
  /** Processes of a dead run that were killed. */
  readonly killed: number[];
  /** Profile directories removed. */
  readonly removed: string[];
}

/** `pid ppid command…` per line, as `ps -axo pid=,ppid=,command=` prints it. */
export function parseProcessList(listing: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match !== null) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! });
  }
  return rows;
}

/** The profile a browser process was started on, when it is one of this suite's: `--user-data-dir=<tmp>/qb-adversarial-*`, exactly. */
export function profileOf(command: string, tmp: string): string | null {
  const match = /--user-data-dir=(\S+)/u.exec(command);
  if (match === null) return null;
  const dir = resolve(match[1]!);
  const root = resolve(tmp);
  return dir.startsWith(`${root}/${PROFILE_PREFIX}`) && !dir.slice(root.length + 1).includes('/') ? dir : null;
}

function ownerOf(dir: string): number | null {
  try {
    const pid = Number(readFileSync(join(dir, OWNER_FILE), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isOurDirectory(dir: string): boolean {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Report what is running on this suite's profiles and reclaim what a dead run left. A profile is **in use** while its owner is alive — another worktree's run
 * on the same machine is left to finish. A profile whose owner is dead has its browser killed and its directory removed. A profile with no owner file (made
 * before the file existed) is treated as dead only when a browser on it has been orphaned to init, so that a browser started by a run still going is never taken.
 */
export function sweep(deps: SweepDeps): SweepReport {
  const rows = deps.processes();
  const byProfile = new Map<string, ProcessRow[]>();
  for (const row of rows) {
    const profile = profileOf(row.command, deps.tmp);
    if (profile !== null) byProfile.set(profile, [...(byProfile.get(profile) ?? []), row]);
  }
  const directories = readdirSync(deps.tmp)
    .filter((name) => name.startsWith(PROFILE_PREFIX))
    .map((name) => join(resolve(deps.tmp), name))
    .filter(isOurDirectory);
  const profiles = new Set([...directories, ...byProfile.keys()]);

  const inUse: string[] = [];
  const killed: number[] = [];
  const removed: string[] = [];
  for (const dir of [...profiles].sort()) {
    const users = byProfile.get(dir) ?? [];
    const owner = ownerOf(dir);
    const dead = owner === null ? users.every((row) => row.ppid === 1) : !deps.isAlive(owner);
    if (!dead) {
      inUse.push(dir);
      continue;
    }
    for (const row of users) {
      deps.kill(row.pid);
      killed.push(row.pid);
    }
    if (isOurDirectory(dir)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removed.push(dir);
    }
  }
  return { inUse, killed, removed };
}

export const realDeps = (): SweepDeps => ({
  tmp: tmpdir(),
  processes: () => parseProcessList(execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  kill: (pid) => {
    // a browser leads its own process group (see chrome.ts), so the group takes its helpers with it
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
        return;
      } catch {
        // not a group leader, or already gone
      }
    }
  },
});

export function describeSweep(report: SweepReport): string[] {
  const lines: string[] = [];
  if (report.inUse.length > 0) lines.push(`adversarial: ${report.inUse.length} profile(s) belong to a run that is still alive and were left alone: ${report.inUse.join(', ')}`);
  if (report.killed.length > 0 || report.removed.length > 0) lines.push(`adversarial: swept ${report.killed.length} process(es) and ${report.removed.length} profile(s) left by runs that died`);
  return lines;
}

// ---- what this process created ---------------------------------------------------------------------------------------------------------------------------

const children = new Set<ChildProcess>();
const profiles = new Set<string>();
let hooked = false;

function release(): void {
  for (const child of children) {
    try {
      process.kill(-(child.pid as number), 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  children.clear();
  for (const dir of profiles) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  profiles.clear();
}

/** The browser dies with this process: on a normal exit, and on the signals a stopped worker or an interrupted suite sends. A `SIGKILL` cannot be caught — the next sweep reclaims that one. */
function hook(): void {
  if (hooked) return;
  hooked = true;
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const onSignal = (): void => {
      release();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

export function trackBrowser(child: ChildProcess): void {
  hook();
  children.add(child);
  child.once('exit', () => children.delete(child));
}

/** A fresh profile directory, stamped with the pid of the run that owns it, removed when that run ends. */
export function newProfileDir(): string {
  hook();
  const dir = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  writeFileSync(join(dir, OWNER_FILE), String(process.pid));
  profiles.add(dir);
  return dir;
}
