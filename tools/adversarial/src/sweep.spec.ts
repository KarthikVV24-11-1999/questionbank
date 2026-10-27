import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from './browser-run.js';
import { OWNER_FILE, PROFILE_PREFIX, newProfileDir, parseProcessList, profileOf, realDeps, sweep, type SweepDeps } from './profiles.js';

/**
 * The sweep reclaims what a run that died left, and only that (D75). It is exercised twice: against a listing it is handed, where every refusal can be
 * constructed, and against real processes, where "the stray is gone" is a fact about the machine.
 */
const TMP = '/var/tmp-root';

describe("which processes are this suite's", () => {
  it('reads a process listing', () => {
    expect(parseProcessList('  101     1 /usr/bin/a --x\n  202   101 /usr/bin/b\n\n')).toEqual([
      { pid: 101, ppid: 1, command: '/usr/bin/a --x' },
      { pid: 202, ppid: 101, command: '/usr/bin/b' },
    ]);
  });

  it("matches only a profile directly under the temp directory with this suite's prefix", () => {
    expect(profileOf(`chrome --user-data-dir=${TMP}/${PROFILE_PREFIX}abc123 about:blank`, TMP)).toBe(`${TMP}/${PROFILE_PREFIX}abc123`);
    const refused = [
      `chrome --user-data-dir=${TMP}/qb-prof-abc123`, // a prefix this repository has never created
      'chrome --user-data-dir=/Users/dev/Library/Google/Chrome', // a developer's own browser
      `chrome --user-data-dir=/other/${PROFILE_PREFIX}abc123`, // the right name in the wrong place
      `chrome --user-data-dir=${TMP}/${PROFILE_PREFIX}abc123/Default`, // inside a profile, not a profile
      'chrome --headless about:blank', // no profile at all
    ];
    expect(refused.map((command) => profileOf(command, TMP))).toEqual([null, null, null, null, null]);
  });
});

describe('the sweep, over a listing', () => {
  const roots: string[] = [];
  const make = (names: readonly string[], owner: (name: string) => number | null) => {
    const tmp = mkdtempSync(join(tmpdir(), 'qb-sweep-test-'));
    roots.push(tmp);
    for (const name of names) {
      mkdirSync(join(tmp, name));
      const pid = owner(name);
      if (pid !== null) writeFileSync(join(tmp, name, OWNER_FILE), String(pid));
    }
    return tmp;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const depsFor = (tmp: string, rows: { pid: number; ppid: number; profile: string }[], alive: number[]) => {
    const killed: number[] = [];
    const deps: SweepDeps = {
      tmp,
      processes: () => rows.map((row) => ({ pid: row.pid, ppid: row.ppid, command: `chrome --user-data-dir=${join(tmp, row.profile)}` })),
      isAlive: (pid) => alive.includes(pid),
      kill: (pid) => killed.push(pid),
    };
    return { deps, killed };
  };

  it("kills and removes a dead run's browser and profile, and leaves a live run's alone", () => {
    const tmp = make([`${PROFILE_PREFIX}dead`, `${PROFILE_PREFIX}live`], (name) => (name.endsWith('dead') ? 900 : 800));
    const { deps, killed } = depsFor(tmp, [{ pid: 11, ppid: 900, profile: `${PROFILE_PREFIX}dead` }, { pid: 12, ppid: 800, profile: `${PROFILE_PREFIX}live` }], [800]);
    const report = sweep(deps);
    expect(killed).toEqual([11]);
    expect(report.removed).toEqual([join(tmp, `${PROFILE_PREFIX}dead`)]);
    expect(report.inUse).toEqual([join(tmp, `${PROFILE_PREFIX}live`)]);
    expect(existsSync(join(tmp, `${PROFILE_PREFIX}dead`))).toBe(false);
    expect(existsSync(join(tmp, `${PROFILE_PREFIX}live`))).toBe(true);
  });

  it("never touches what it did not create: another prefix, another tool's directory", () => {
    const tmp = make(['qb-prof-old', 'other-tool-cache', `${PROFILE_PREFIX}dead`], () => null);
    const { deps, killed } = depsFor(
      tmp,
      [
        { pid: 21, ppid: 1, profile: 'qb-prof-old' },
        { pid: 22, ppid: 1, profile: 'other-tool-cache' },
      ],
      [],
    );
    const report = sweep(deps);
    expect(killed).toEqual([]);
    expect(report.removed).toEqual([join(tmp, `${PROFILE_PREFIX}dead`)]);
    expect(existsSync(join(tmp, 'qb-prof-old'))).toBe(true);
    expect(existsSync(join(tmp, 'other-tool-cache'))).toBe(true);
  });

  it('treats a profile with no owner file as dead only when its browser was orphaned, so a run in progress keeps its own', () => {
    const tmp = make([`${PROFILE_PREFIX}orphaned`, `${PROFILE_PREFIX}parented`], () => null);
    const { deps, killed } = depsFor(tmp, [{ pid: 31, ppid: 1, profile: `${PROFILE_PREFIX}orphaned` }, { pid: 32, ppid: 4242, profile: `${PROFILE_PREFIX}parented` }], []);
    const report = sweep(deps);
    expect(killed).toEqual([31]);
    expect(report.inUse).toEqual([join(tmp, `${PROFILE_PREFIX}parented`)]);
  });

  it('does not follow a symbolic link named like a profile', () => {
    const tmp = make([], () => null);
    const target = mkdtempSync(join(tmpdir(), 'qb-sweep-target-'));
    roots.push(target);
    writeFileSync(join(target, 'keep.txt'), 'x');
    symlinkSync(target, join(tmp, `${PROFILE_PREFIX}link`));
    sweep(depsFor(tmp, [], []).deps);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  });
});

describe('the sweep, over real processes', () => {
  const started: ChildProcess[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const child of started.splice(0)) child.kill('SIGKILL');
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const stray = (dir: string): ChildProcess => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${dir}`], { stdio: 'ignore', detached: true });
    started.push(child);
    return child;
  };
  const exited = (child: ChildProcess) => new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const listed = (...pids: (number | undefined)[]) => realDeps().processes().filter((row) => pids.includes(row.pid)).length === pids.length;

  it("kills a stray whose owning run is dead, removes its profile, and leaves a stranger's process running", async () => {
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await exited(dead);
    const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
    dirs.push(profile);
    writeFileSync(join(profile, OWNER_FILE), String(dead.pid));
    const foreign = mkdtempSync(join(tmpdir(), 'qb-prof-'));
    dirs.push(foreign);

    const ours = stray(profile);
    const theirs = stray(foreign);
    await waitFor('both processes are listed', () => listed(ours.pid, theirs.pid));
    const gone = exited(ours);

    const report = sweep(realDeps());
    await gone;
    expect(report.killed).toContain(ours.pid);
    expect(report.killed).not.toContain(theirs.pid);
    expect(existsSync(profile)).toBe(false);
    expect(realDeps().isAlive(theirs.pid as number)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });

  it('leaves a profile alone while the run that made it is alive', async () => {
    const profile = newProfileDir();
    const mine = stray(profile);
    await waitFor('the process is listed', () => listed(mine.pid));
    const report = sweep(realDeps());
    expect(report.inUse).toContain(profile);
    expect(realDeps().isAlive(mine.pid as number)).toBe(true);
    expect(existsSync(profile)).toBe(true);
  });
});
