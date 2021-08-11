import { Writable } from 'stream';
import {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
  SpawnSyncReturns,
  spawn,
  spawnSync,
} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import debug from 'debug';
import getos from 'getos';
import { SemVer } from 'semver';
import { inspect } from 'util';

import { Installer } from './installer';
import { ElectronVersions, Versions } from './versions';
import { Fiddle, FiddleFactory, FiddleSource } from './fiddle';
import { DefaultPaths, Paths } from './paths';

export interface RunnerOptions {
  // extra arguments to be appended to the electron invocation
  args?: string[];
  // if true, use xvfb-run on *nix
  headless?: boolean;
  // where the test's output should be written
  out?: Writable;
  // whether to show config info (e.g. platform os & arch) in the log
  showConfig?: boolean;
}

const DefaultRunnerOpts: RunnerOptions = Object.freeze({
  args: [],
  headless: false,
  out: process.stdout,
  showConfig: true,
});

export type RunnerSpawnOptions = SpawnOptions & RunnerOptions;

export type RunnerSpawnSyncOptions = SpawnSyncOptions & RunnerOptions;

export interface TestResult {
  status: 'test_passed' | 'test_failed' | 'test_error' | 'system_error';
}

export interface BisectResult {
  range?: [string, string];
  status: 'bisect_succeeded' | 'test_error' | 'system_error';
}

export class Runner {
  private osInfo = '';

  private constructor(
    private readonly installer: Installer,
    private readonly versions: Versions,
    private readonly fiddleFactory: FiddleFactory,
  ) {
    getos((err, result) => (this.osInfo = inspect(result || err)));
  }

  public static async create(opts: {
    installer?: Installer;
    fiddleFactory?: FiddleFactory;
    paths?: Partial<Paths>;
    versions?: Versions;
  }): Promise<Runner> {
    const paths = Object.freeze({ ...DefaultPaths, ...(opts.paths || {}) });
    const installer = opts.installer || new Installer(paths);
    const versions = opts.versions || (await ElectronVersions.create(paths));
    const factory = opts.fiddleFactory || new FiddleFactory(paths.fiddles);
    return new Runner(installer, versions, factory);
  }

  /**
   * Figure out how to run the user-specified `electron` value.
   *
   * - if it's an existing directory, look for an execPath in it.
   * - if it's an existing file, run it. It's a local build.
   * - if it's a version number, delegate to the installer
   *
   * @param val - a version number, directory, or executable
   * @returns a path to an Electron executable
   */
  private async getExec(electron: string): Promise<string> {
    try {
      const stat = fs.statSync(electron);
      // if it's on the filesystem but not a directory, use it directly
      if (!stat.isDirectory()) return electron;
      // if it's on the filesystem as a directory, look for execPath
      const name = Installer.getExecPath(electron);
      if (fs.existsSync(name)) return name;
    } catch {
      // if it's a version, install it
      if (this.versions.isVersion(electron))
        return await this.installer.install(electron);
    }
    throw new Error(`Unrecognized electron name: "${electron}"`);
  }

  // FIXME(anyone): minor wart, 'source' is incorrect here if it's a local build
  private spawnInfo = (version: string, exec: string, fiddle: Fiddle) =>
    [
      '',
      '🧪 Testing',
      '',
      `  - date: ${new Date().toISOString()}`,
      '',
      '  - fiddle:',
      `      - source: ${fiddle.source}`,
      `      - local copy: ${path.dirname(fiddle.mainPath)}`,
      '',
      `  - electron_version: ${version}`,
      `      - source: https://github.com/electron/electron/releases/tag/v${version}`,
      `      - local copy: ${path.dirname(exec)}`,
      '',
      '  - test platform:',
      `      - os_arch: ${os.arch()}`,
      `      - os_platform: ${process.platform}`,
      `      - os_release: ${os.release()}`,
      `      - os_version: ${os.version()}`,
      `      - getos: ${this.osInfo}`,
      '',
    ].join('\n');

  /** If headless specified on  *nix, try to run with xvfb-run */
  private static headless(
    exec: string,
    args: string[],
  ): { exec: string; args: string[] } {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      // try to get a free server number
      args.unshift('--auto-servernum', exec);
      exec = 'xvfb-run';
    }
    return { exec, args };
  }

  public async spawn(
    versionIn: string | SemVer,
    fiddleIn: FiddleSource,
    opts: RunnerSpawnOptions = {},
  ): Promise<ChildProcess> {
    const d = debug('fiddle-core:Runner.spawn');

    // process the input parameters
    opts = { ...DefaultRunnerOpts, ...opts };
    const version = versionIn instanceof SemVer ? versionIn.version : versionIn;
    const fiddle = await this.fiddleFactory.create(fiddleIn);
    if (!fiddle) throw new Error(`Invalid fiddle: "${inspect(fiddleIn)}"`);

    // set up the electron binary and the fiddle
    const electronExec = await this.getExec(version);
    let exec = electronExec;
    let args = [...(opts.args || []), fiddle.mainPath];
    if (opts.headless) ({ exec, args } = Runner.headless(exec, args));

    if (opts.out && opts.showConfig) {
      opts.out.write(`${this.spawnInfo(version, electronExec, fiddle)}\n`);
    }

    d(inspect({ exec, args, opts }));

    const child = spawn(exec, args, opts);
    if (opts.out) {
      child.stdout?.pipe(opts.out);
      child.stderr?.pipe(opts.out);
    }

    return child;
  }

  public async spawnSync(
    versionIn: string | SemVer,
    fiddleIn: FiddleSource,
    opts: RunnerSpawnSyncOptions = {},
  ): Promise<SpawnSyncReturns<string>> {
    const d = debug('fiddle-core:Runner.spawnSync');

    // process the input parameters
    opts = { ...DefaultRunnerOpts, ...opts };
    const version = versionIn instanceof SemVer ? versionIn.version : versionIn;
    const fiddle = await this.fiddleFactory.create(fiddleIn);
    if (!fiddle) throw new Error(`Invalid fiddle: "${inspect(fiddleIn)}"`);

    // set up the electron binary and the fiddle
    const electronExec = await this.getExec(version);
    let exec = electronExec;
    let args = [...(opts.args || []), fiddle.mainPath];
    if (opts.headless) ({ exec, args } = Runner.headless(exec, args));

    d(inspect({ exec, args, opts }));
    const result = spawnSync(exec, args, {
      ...opts,
      encoding: 'utf8',
    });

    if (opts.out) {
      if (opts.showConfig)
        opts.out.write(`${this.spawnInfo(version, electronExec, fiddle)}\n`);
      opts.out.write(result.stdout);
    }

    return result;
  }

  private static displayEmoji(result: TestResult): string {
    switch (result.status) {
      case 'system_error':
        return '🟠';
      case 'test_error':
        return '🔵';
      case 'test_failed':
        return '🔴';
      case 'test_passed':
        return '🟢';
    }
  }

  public static displayResult(result: TestResult): string {
    const text = Runner.displayEmoji(result);
    switch (result.status) {
      case 'system_error':
        return text + ' system error: test did not pass or fail';
      case 'test_error':
        return text + ' test error: test did not pass or fail';
      case 'test_failed':
        return text + ' failed';
      case 'test_passed':
        return text + ' passed';
    }
  }

  public async run(
    version: string | SemVer,
    fiddle: FiddleSource,
    opts: RunnerSpawnSyncOptions = DefaultRunnerOpts,
  ): Promise<TestResult> {
    const subprocess = await this.spawn(version, fiddle, opts);

    return new Promise((resolve) => {
      subprocess.on('error', () => {
        return resolve({ status: 'system_error' });
      });

      subprocess.on('exit', (code) => {
        if (code === 0) return resolve({ status: 'test_passed' });
        if (code === 1) return resolve({ status: 'test_failed' });
        return resolve({ status: 'test_error' });
      });
    });
  }

  public async bisect(
    version_a: string | SemVer,
    version_b: string | SemVer,
    fiddleIn: FiddleSource,
    opts: RunnerSpawnSyncOptions = DefaultRunnerOpts,
  ): Promise<BisectResult> {
    const { out } = opts;
    const log = (first: unknown, ...rest: unknown[]) => {
      if (out) {
        out.write([first, ...rest].join(' '));
        out.write('\n');
      }
    };

    const versions = this.versions.inRange(version_a, version_b);
    const fiddle = await this.fiddleFactory.create(fiddleIn);
    if (!fiddle) throw new Error(`Invalid fiddle: "${inspect(fiddleIn)}"`);

    const displayIndex = (i: number) => '#' + i.toString().padStart(4, ' ');

    log(
      [
        '📐 Bisect Requested',
        '',
        ` - gist is ${fiddle.source}`,
        ` - the version range is [${version_a.toString()}..${version_b.toString()}]`,
        ` - there are ${versions.length} versions in this range:`,
        '',
        ...versions.map((ver, i) => `${displayIndex(i)} - ${ver.version}`),
      ].join('\n'),
    );

    // bisect through the releases
    let left = 0;
    let right = versions.length - 1;
    let result: TestResult | undefined = undefined;
    const testOrder: (number | undefined)[] = [];
    const results = new Array<TestResult>(versions.length);
    while (left + 1 < right) {
      const mid = Math.round(left + (right - left) / 2);
      const ver = versions[mid];
      testOrder.push(mid);
      log(`bisecting, range [${left}..${right}], mid ${mid} (${ver.version})`);

      result = await this.run(ver.version, fiddle, opts);
      results[mid] = result;
      log(`${Runner.displayResult(result)} ${versions[mid].version}\n`);

      if (result.status === 'test_passed') {
        left = mid;
        continue;
      } else if (result.status === 'test_failed') {
        right = mid;
        continue;
      } else {
        break;
      }
    }

    log(`🏁 finished bisecting across ${versions.length} versions...`);
    versions.forEach((ver, i) => {
      const n = testOrder.indexOf(i);
      if (n === -1) return;
      log(
        displayIndex(i),
        Runner.displayResult(results[i]),
        ver,
        `(test #${n + 1})`,
      );
    });

    log('\n🏁 Done bisecting');
    const success =
      results[left].status === 'test_passed' &&
      results[right].status === 'test_failed';
    if (success) {
      const good = versions[left].version;
      const bad = versions[right].version;
      log(
        [
          `${Runner.displayResult(results[left])} ${good}`,
          `${Runner.displayResult(results[right])} ${bad}`,
          'Commits between versions:',
          `https://github.com/electron/electron/compare/v${good}...v${bad} ↔`,
        ].join('\n'),
      );
    } else {
      // FIXME: log some failure
    }

    if (success) {
      return {
        range: [versions[left].version, versions[right].version],
        status: 'bisect_succeeded',
      };
    }
    if (result?.status === 'test_error' || result?.status === 'system_error') {
      return { status: result.status };
    }
    return { status: 'system_error' };
  }
}
