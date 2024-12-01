import * as fs from 'fs-extra';
import * as path from 'path';
import debug from 'debug';
import simpleGit from 'simple-git';
import { createHash } from 'crypto';

import { DefaultPaths } from './paths';

function hashString(str: string): string {
  const md5sum = createHash('md5');
  md5sum.update(str);
  return md5sum.digest('hex');
}

/** This class represents a fiddle */
export class Fiddle {
  constructor(
    /** It serves as the entry point or the primary script file for the fiddle */
    public readonly mainPath: string, // /path/to/main.js
    /** Is the cource of the fiddle */
    public readonly source: string,
  ) {}

  /** This method deletes the fiddle from the system */
  public remove(): Promise<void> {
    return fs.remove(path.dirname(this.mainPath));
  }
}

/**
 * - Iterable of [string, string] - filename-to-content key/value pairs
 * - string of form '/path/to/fiddle' - a fiddle on the filesystem
 * - string of form 'https://github.com/my/repo.git' - a git repo fiddle
 * - string of form '642fa8daaebea6044c9079e3f8a46390' - a github gist fiddle
 */
export type FiddleSource = Fiddle | string | Iterable<[string, string]>;

/**
 * This class is responsible for creating instances of the Fiddle class
 * and it has methods to create a fiddle from various source
 */
export class FiddleFactory {
  constructor(private readonly fiddles: string = DefaultPaths.fiddles) {}

  /** This method creates a Fiddle instance by fetching a GitHub Gist and cloning it into a temporary directory, */
  public async fromGist(gistId: string): Promise<Fiddle> {
    return this.fromRepo(`https://gist.github.com/${gistId}.git`);
  }

  /** This method creates a Fiddle instance by making a temporary copy of the fiddle from a specified source */
  public async fromFolder(source: string): Promise<Fiddle> {
    const d = debug('fiddle-core:FiddleFactory:fromFolder');

    // make a tmp copy of this fiddle
    const folder = path.join(this.fiddles, hashString(source));
    d({ source, folder });
    await fs.remove(folder);

    // Disable asar in case any deps bundle Electron - ex. @electron/remote
    const { noAsar } = process;
    process.noAsar = true;
    await fs.copy(source, folder);
    process.noAsar = noAsar;

    return new Fiddle(path.join(folder, 'main.js'), source);
  }

  /**
   * This method creates a Fiddle instance by cloning a Git repository into a temporary directory,
   * optionally checking out a specified branch,
   * and setting the main file path based on the cloned files.
   */
  public async fromRepo(url: string, checkout = 'master'): Promise<Fiddle> {
    const d = debug('fiddle-core:FiddleFactory:fromRepo');
    const folder = path.join(this.fiddles, hashString(url));
    d({ url, checkout, folder });

    // get the repo
    if (!fs.existsSync(folder)) {
      d(`cloning "${url}" into "${folder}"`);
      const git = simpleGit();
      await git.clone(url, folder, { '--depth': 1 });
    }

    const git = simpleGit(folder);
    await git.checkout(checkout);
    await git.pull('origin', checkout);

    return new Fiddle(path.join(folder, 'main.js'), url);
  }

  /**
   * This method creates a Fiddle instance by saving a collection of filename-content pairs to a temporary directory
   * and setting the main file path accordingly.
   */
  public async fromEntries(src: Iterable<[string, string]>): Promise<Fiddle> {
    const d = debug('fiddle-core:FiddleFactory:fromEntries');
    const map = new Map<string, string>(src);

    // make a name for the directory that will hold our temp copy of the fiddle
    const md5sum = createHash('md5');
    for (const content of map.values()) md5sum.update(content);
    const hash = md5sum.digest('hex');
    const folder = path.join(this.fiddles, hash);
    d({ folder });

    // save content to that temp directory
    await Promise.all(
      [...map.entries()].map(([filename, content]) =>
        fs.outputFile(path.join(folder, filename), content, 'utf8'),
      ),
    );

    return new Fiddle(path.join(folder, 'main.js'), 'entries');
  }

  /** This method determines the source type and calls the appropriate method to create the fiddle */
  public async create(src: FiddleSource): Promise<Fiddle | undefined> {
    if (src instanceof Fiddle) return src;

    if (typeof src === 'string') {
      if (fs.existsSync(src)) return this.fromFolder(src);
      if (/^[0-9A-Fa-f]{32}$/.test(src)) return this.fromGist(src);
      if (/^https:/.test(src) || /\.git$/.test(src)) return this.fromRepo(src);
      return;
    }

    return this.fromEntries(src);
  }
}
