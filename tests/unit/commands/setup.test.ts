import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { getLocalServerLaunchConfig, getPackageRoot } from '../../../src/commands/setup.js';

const REPO_ROOT = resolve(__dirname, '../../..');

describe('setup helpers', () => {
  it('finds the package root from a nested directory', () => {
    const nestedDir = resolve(REPO_ROOT, 'src', 'commands');
    expect(getPackageRoot(nestedDir)).toBe(REPO_ROOT);
  });

  it('returns the PATH-based comparo command config', () => {
    expect(getLocalServerLaunchConfig()).toEqual({
      command: 'comparo',
      args: ['mcp', 'serve'],
    });
  });
});
