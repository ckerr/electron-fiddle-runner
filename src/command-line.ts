import { inspect } from 'util';
import debug from 'debug';

import { ElectronVersions } from './versions';
import { Fiddle, FiddleFactory } from './fiddle';
import { Runner } from './runner';

/**
 * Function handles command-line arguments, creates instances of necessary objects and
 * executes specific commands based on the arguments provided.
 * It logs debug information and exits the process if invalid parameters are detected.
 */
export async function runFromCommandLine(argv: string[]): Promise<void> {
  const d = debug('fiddle-core:runFromCommandLine');

  d(inspect({ argv }));
  const versions = await ElectronVersions.create();
  const fiddleFactory = new FiddleFactory();
  const runner = await Runner.create({ versions, fiddleFactory });
  const versionArgs: string[] = [];

  type Cmd = 'bisect' | 'test' | undefined;
  let cmd: Cmd = undefined;
  let fiddle: Fiddle | undefined = undefined;

  d('argv', inspect(argv));
  for (const param of argv) {
    d('param', param);
    if (param === 'bisect') {
      cmd = 'bisect';
    } else if (param === 'test' || param === 'start' || param === 'run') {
      d('it is test');
      cmd = 'test';
    } else if (versions.isVersion(param)) {
      versionArgs.push(param);
    } else {
      fiddle = await fiddleFactory.create(param);
      if (fiddle) continue;
      console.error(
        `Unrecognized parameter "${param}". Must be 'test', 'start', 'bisect', a version, a gist, a folder, or a repo URL.`,
      );
      process.exit(1);
    }
  }

  d(inspect({ cmd, fiddle, versions }));

  if (!cmd) {
    console.error(
      "Command-line parameters must include one of ['bisect', 'test', 'start']",
    );
    process.exit(1);
  }

  if (!fiddle) {
    console.error('No fiddle specified.');
    process.exit(1);
  }

  if (cmd === 'test' && versionArgs.length === 1) {
    const result = await runner.run(versionArgs[0], fiddle, {
      out: process.stdout,
    });
    const vals = ['test_passed', 'test_failed', 'test_error', 'system_error'];
    process.exitCode = vals.indexOf(result.status);
    return;
  }

  if (cmd === 'bisect' && versionArgs.length === 2) {
    const result = await runner.bisect(versionArgs[0], versionArgs[1], fiddle, {
      out: process.stdout,
    });
    const vals = ['bisect_succeeded', 'test_error', 'system_error'];
    process.exitCode = vals.indexOf(result.status);
    return;
  }

  console.error(`Invalid parameters. Got ${cmd}, ${versionArgs.join(', ')}`);
  process.exit(1);
}
