import * as fs from 'fs-extra';
import { parse as semverParse, SemVer } from 'semver';
import debug from 'debug';
import fetch from 'node-fetch';

export { SemVer };

import { DefaultPaths, Paths } from './paths';

export type SemOrStr = SemVer | string;

/**
 * Interface for an object that manages a list of Electron releases.
 *
 * See {@link BaseVersions} for testing situations.
 * See {@link ElectronVersions} for production.
 */
export interface Versions {
  /** Semver-Major numbers of branches that only have prereleases */
  readonly prereleaseMajors: number[];

  /** Semver-Major numbers of branches that have supported stable releases */
  readonly supportedMajors: number[];

  /** Semver-Major numbers of branches that are no longer supported */
  readonly obsoleteMajors: number[];

  /** The latest release (by version, not by date) */
  readonly latest: SemVer | undefined;

  /** The latest stable (by version, not by date) */
  readonly latestStable: SemVer | undefined;

  /** Full list of all known Electron releases, Sorted in branch order. */
  readonly versions: SemVer[];

  /** @returns true iff `version` is a release that this object knows about */
  isVersion(version: SemOrStr): boolean;

  /** @returns all versions matching that major number. Sorted in branch order. */
  inMajor(major: number): SemVer[];

  /** @returns all versions in a range, inclusive. Sorted in branch order. */
  inRange(a: SemOrStr, b: SemOrStr): SemVer[];
}

export function compareVersions(a: SemVer, b: SemVer): number {
  const l = a.compareMain(b);
  if (l) return l;
  // Electron's approach is nightly -> other prerelease tags -> stable,
  // so force `nightly` to sort before other prerelease tags.
  const [prea] = a.prerelease;
  const [preb] = b.prerelease;
  if (prea === 'nightly' && preb !== 'nightly') return -1;
  if (prea !== 'nightly' && preb === 'nightly') return 1;
  return a.comparePre(b);
}

// ts type guards

function hasVersion(val: unknown): val is { version: unknown } {
  return typeof val === 'object' && val !== null && 'version' in val;
}

function isArrayOfVersionObjects(
  val: unknown,
): val is Array<{ version: string }> {
  return (
    Array.isArray(val) &&
    val.every((item) => hasVersion(item) && typeof item.version === 'string')
  );
}

function isArrayOfStrings(val: unknown): val is Array<string> {
  return Array.isArray(val) && val.every((item) => typeof item === 'string');
}

const NUM_SUPPORTED_MAJORS = 4;

/**
 * Implementation of {@link Versions} that does everything except self-populate.
 * It needs to be fed version info in its constructor.
 *
 * In production, use subclass '{@link ElectronVersions}'. This base class is
 * useful in testing because it's an easy way to inject fake test data into a
 * real Versions object.
 */
export class BaseVersions implements Versions {
  private readonly map = new Map<string, SemVer>();

  protected setVersions(val: unknown): void {
    // build the array
    let parsed: Array<SemVer | null> = [];
    if (isArrayOfVersionObjects(val)) {
      parsed = val.map(({ version }) => semverParse(version));
    } else if (isArrayOfStrings(val)) {
      parsed = val.map((version) => semverParse(version));
    } else {
      console.warn('Unrecognized versions:', val);
    }

    // insert them in sorted order
    const semvers = parsed.filter((sem) => Boolean(sem)) as SemVer[];
    semvers.sort((a, b) => compareVersions(a, b));
    this.map.clear();
    for (const sem of semvers) this.map.set(sem.version, sem);
  }

  public constructor(versions: unknown) {
    this.setVersions(versions);
  }

  public get prereleaseMajors(): number[] {
    const majors = new Set<number>();
    for (const ver of this.map.values()) {
      majors.add(ver.major);
    }
    for (const ver of this.map.values()) {
      if (ver.prerelease.length === 0) {
        majors.delete(ver.major);
      }
    }
    return [...majors];
  }

  public get stableMajors(): number[] {
    const majors = new Set<number>();
    for (const ver of this.map.values()) {
      if (ver.prerelease.length === 0) {
        majors.add(ver.major);
      }
    }
    return [...majors];
  }

  public get supportedMajors(): number[] {
    return this.stableMajors.slice(-NUM_SUPPORTED_MAJORS);
  }

  public get obsoleteMajors(): number[] {
    return this.stableMajors.slice(0, -NUM_SUPPORTED_MAJORS);
  }

  public get versions(): SemVer[] {
    return [...this.map.values()];
  }

  public get latest(): SemVer | undefined {
    return this.versions.pop();
  }

  public get latestStable(): SemVer | undefined {
    let stable: SemVer | undefined = undefined;
    for (const ver of this.map.values()) {
      if (ver.prerelease.length === 0) {
        stable = ver;
      }
    }
    return stable;
  }

  public isVersion(ver: SemOrStr): boolean {
    return this.map.has(typeof ver === 'string' ? ver : ver.version);
  }

  public inMajor(major: number): SemVer[] {
    const versions: SemVer[] = [];
    for (const ver of this.map.values()) {
      if (ver.major === major) {
        versions.push(ver);
      }
    }
    return versions;
  }

  public inRange(a: SemOrStr, b: SemOrStr): SemVer[] {
    if (typeof a !== 'string') a = a.version;
    if (typeof b !== 'string') b = b.version;

    const versions = [...this.map.values()];
    let first = versions.findIndex((ver) => ver.version === a);
    let last = versions.findIndex((ver) => ver.version === b);
    if (first > last) [first, last] = [last, first];
    return versions.slice(first, last + 1);
  }
}

/**
 * Implementation of Versions that self-populates from release information at
 * https://releases.electronjs.org/releases.json .
 *
 * This is generally what to use in production.
 */
export class ElectronVersions extends BaseVersions {
  private constructor(
    private readonly versionsCache: string,
    private mtimeMs: number,
    values: unknown,
  ) {
    super(values);
  }

  private static async fetchVersions(cacheFile: string): Promise<unknown> {
    const d = debug('fiddle-core:ElectronVersions:fetchVersions');
    const url = 'https://releases.electronjs.org/releases.json';
    d('fetching releases list from', url);
    const response = await fetch(url);
    const json = (await response.json()) as unknown;
    await fs.outputJson(cacheFile, json);
    return json;
  }

  private static isCacheFresh(cacheTimeMs: number, now: number): boolean {
    const VERSION_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // cache for N hours
    return now <= cacheTimeMs + VERSION_CACHE_TTL_MS;
  }

  public static async create(
    paths: Partial<Paths> = {},
  ): Promise<ElectronVersions> {
    const d = debug('fiddle-core:ElectronVersions:create');
    const { versionsCache } = { ...DefaultPaths, ...paths };

    let versions: unknown;
    let staleCache = false;
    const now = Date.now();
    try {
      const st = await fs.stat(versionsCache);
      versions = await fs.readJson(versionsCache);
      staleCache = !ElectronVersions.isCacheFresh(st.mtimeMs, now);
    } catch (err) {
      d('cache file missing or cannot be read', err);
    }

    if (!versions || staleCache) {
      try {
        versions = await ElectronVersions.fetchVersions(versionsCache);
      } catch (err) {
        d('error fetching versions', err);
      }
    }

    return new ElectronVersions(versionsCache, now, versions);
  }

  // update the cache
  public async fetch(): Promise<void> {
    const d = debug('fiddle-core:ElectronVersions:fetch');
    const { mtimeMs, versionsCache } = this;
    try {
      this.mtimeMs = Date.now();
      const versions = await ElectronVersions.fetchVersions(versionsCache);
      this.setVersions(versions);
      d(`saved "${versionsCache}"`);
    } catch (err) {
      d('error fetching versions', err);
      this.mtimeMs = mtimeMs;
    }
  }

  // update the cache iff it's too old
  private async keepFresh(): Promise<void> {
    if (!ElectronVersions.isCacheFresh(this.mtimeMs, Date.now())) {
      await this.fetch();
    }
  }

  public override get prereleaseMajors(): number[] {
    void this.keepFresh();
    return super.prereleaseMajors;
  }
  public override get stableMajors(): number[] {
    void this.keepFresh();
    return super.stableMajors;
  }
  public override get supportedMajors(): number[] {
    void this.keepFresh();
    return super.supportedMajors;
  }
  public override get obsoleteMajors(): number[] {
    void this.keepFresh();
    return super.obsoleteMajors;
  }
  public override get versions(): SemVer[] {
    void this.keepFresh();
    return super.versions;
  }
  public override get latest(): SemVer | undefined {
    void this.keepFresh();
    return super.latest;
  }
  public override get latestStable(): SemVer | undefined {
    void this.keepFresh();
    return super.latestStable;
  }
  public override isVersion(ver: SemOrStr): boolean {
    void this.keepFresh();
    return super.isVersion(ver);
  }
  public override inMajor(major: number): SemVer[] {
    void this.keepFresh();
    return super.inMajor(major);
  }
  public override inRange(a: SemOrStr, b: SemOrStr): SemVer[] {
    void this.keepFresh();
    return super.inRange(a, b);
  }
}
