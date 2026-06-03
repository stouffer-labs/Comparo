import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { getLocalServerLaunchConfig, getPackageRoot } from '../../../src/commands/setup.js';

const REPO_ROOT = resolve(__dirname, '../../..');

describe('setup helpers', () => {
  it('finds the package root from a nested directory', () => {
    const nestedDir = resolve(REPO_ROOT, 'src', 'commands');
    expect(getPackageRoot(nestedDir)).toBe(REPO_ROOT);
  });

  it('registers an absolute, PATH-independent node + cli.js command', () => {
    // The MCP host spawns the registered command directly (no shell), inheriting
    // whatever PATH it was launched with. So the registration must NOT rely on a
    // bare command name or a `#!/usr/bin/env node` shebang — it points at a stable
    // node symlink (<packageRoot>/bin/node, repointed by install.sh) and the
    // absolute built cli.js. See getLocalServerLaunchConfig for the rationale.
    const root = getPackageRoot();
    expect(getLocalServerLaunchConfig()).toEqual({
      command: join(root, 'bin', 'node'),
      args: [join(root, 'dist', 'src', 'cli.js'), 'mcp', 'serve'],
    });
  });
});
