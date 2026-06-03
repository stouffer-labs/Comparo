import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../utils/process.js';
import { logger } from '../utils/logger.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

interface SetupResult {
  provider: string;
  method: string;
  success: boolean;
  message: string;
}

interface ServerLaunchConfig {
  command: string;
  args: string[];
}

interface InstallSpec {
  addCommand: string;
  addArgs: string[];
  removeCommand?: string;
  removeArgs?: string[];
}

export async function runSetup(dryRun: boolean): Promise<void> {
  console.log(dryRun ? 'Comparo MCP Install (dry run)' : 'Comparo MCP Install');
  console.log('==============\n');

  const results: SetupResult[] = [];
  const serverConfig = getLocalServerLaunchConfig();

  results.push(await setupClaude(dryRun, serverConfig));
  results.push(await setupGemini(dryRun, serverConfig));
  results.push(await setupCodex(dryRun, serverConfig));

  console.log('\nSummary:');
  for (const r of results) {
    const icon = r.success ? '\u2705' : '\u274C';
    console.log(`${icon} ${r.provider}: ${r.message} (${r.method})`);
  }
}

export function getPackageRoot(startDir: string = MODULE_DIR): string {
  let current = realpathSync(startDir);

  while (true) {
    const packageJson = join(current, 'package.json');
    const binEntry = join(current, 'bin', 'comparo.js');

    if (existsSync(packageJson) && existsSync(binEntry)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not find Comparo package root from ${startDir}`);
    }

    current = parent;
  }
}

// Register an absolute node + absolute cli.js so the MCP host can spawn the
// server WITHOUT relying on its inherited PATH. A bare `comparo` (or a script
// with a `#!/usr/bin/env node` shebang) fails whenever the host was launched
// without ~/.local/bin and the nvm node dir on PATH (e.g. GUI/Spotlight or a
// fresh shell) — observed as "Executable not found in $PATH: comparo".
//
// `command` points at a STABLE node symlink (`<packageRoot>/bin/node`) that
// scripts/install.sh repoints at the build-time node on every (re)install.
// This keeps the registration node-version-agnostic: a node upgrade only moves
// the symlink, never requiring the three MCP configs to be rewritten.
export function getLocalServerLaunchConfig(): ServerLaunchConfig {
  const packageRoot = getPackageRoot();
  return {
    command: join(packageRoot, 'bin', 'node'),
    args: [join(packageRoot, 'dist', 'src', 'cli.js'), 'mcp', 'serve'],
  };
}

function formatCommand(config: ServerLaunchConfig): string {
  return [config.command, ...config.args].map(shellEscape).join(' ');
}

function shellEscape(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

async function addOrReplace(spec: InstallSpec): Promise<SetupResult['success'] | 'replaced'> {
  const addResult = await runCommand({
    command: spec.addCommand,
    args: spec.addArgs,
    timeout: 15_000,
  });

  if (addResult.exitCode === 0) {
    return true;
  }

  const alreadyExists = addResult.stderr.toLowerCase().includes('already exists');
  if (!alreadyExists || !spec.removeCommand || !spec.removeArgs) {
    return false;
  }

  const removeResult = await runCommand({
    command: spec.removeCommand,
    args: spec.removeArgs,
    timeout: 15_000,
  });

  if (removeResult.exitCode !== 0) {
    return false;
  }

  const retryResult = await runCommand({
    command: spec.addCommand,
    args: spec.addArgs,
    timeout: 15_000,
  });

  return retryResult.exitCode === 0 ? 'replaced' : false;
}

async function setupClaude(dryRun: boolean, serverConfig: ServerLaunchConfig): Promise<SetupResult> {
  const provider = 'Claude Code';
  try {
    // Try CLI method first
    const checkResult = await runCommand({
      command: 'claude',
      args: ['--version'],
      timeout: 10_000,
    });

    if (checkResult.exitCode !== 0) {
      return { provider, method: 'n/a', success: false, message: 'Claude CLI not installed' };
    }

    if (dryRun) {
      console.log(`Would run: claude mcp add --scope user comparo -- ${formatCommand(serverConfig)}`);
      return { provider, method: 'cli', success: true, message: 'Would configure via CLI' };
    }

    const result = await addOrReplace({
      addCommand: 'claude',
      addArgs: ['mcp', 'add', '--scope', 'user', 'comparo', '--', serverConfig.command, ...serverConfig.args],
      removeCommand: 'claude',
      removeArgs: ['mcp', 'remove', 'comparo', '-s', 'user'],
    });

    if (result === true) {
      return { provider, method: 'cli', success: true, message: 'Configured via claude mcp add' };
    }

    if (result === 'replaced') {
      return { provider, method: 'cli', success: true, message: 'Replaced existing Claude MCP config' };
    }

    const finalAttempt = await runCommand({
      command: 'claude',
      args: ['mcp', 'add', '--scope', 'user', 'comparo', '--', serverConfig.command, ...serverConfig.args],
      timeout: 15_000,
    });
    logger.warn(`claude mcp add failed: ${finalAttempt.stderr}`);
    return { provider, method: 'cli', success: false, message: `Failed: ${finalAttempt.stderr}` };
  } catch (error) {
    return { provider, method: 'n/a', success: false, message: String(error) };
  }
}

async function setupGemini(dryRun: boolean, serverConfig: ServerLaunchConfig): Promise<SetupResult> {
  const provider = 'Gemini CLI';
  try {
    const checkResult = await runCommand({
      command: 'gemini',
      args: ['--version'],
      timeout: 10_000,
    });

    if (checkResult.exitCode !== 0) {
      return { provider, method: 'n/a', success: false, message: 'Gemini CLI not installed' };
    }

    if (dryRun) {
      console.log(`Would run: gemini mcp add --scope user comparo ${formatCommand(serverConfig)}`);
      return { provider, method: 'cli', success: true, message: 'Would configure via CLI' };
    }

    const result = await addOrReplace({
      addCommand: 'gemini',
      addArgs: ['mcp', 'add', '--scope', 'user', 'comparo', serverConfig.command, ...serverConfig.args],
      removeCommand: 'gemini',
      removeArgs: ['mcp', 'remove', '--scope', 'user', 'comparo'],
    });

    if (result === true) {
      return { provider, method: 'cli', success: true, message: 'Configured via gemini mcp add' };
    }

    if (result === 'replaced') {
      return { provider, method: 'cli', success: true, message: 'Replaced existing Gemini MCP config' };
    }

    const finalAttempt = await runCommand({
      command: 'gemini',
      args: ['mcp', 'add', '--scope', 'user', 'comparo', serverConfig.command, ...serverConfig.args],
      timeout: 15_000,
    });
    logger.warn(`gemini mcp add failed: ${finalAttempt.stderr}`);
    return { provider, method: 'cli', success: false, message: `Failed: ${finalAttempt.stderr}` };
  } catch (error) {
    return { provider, method: 'n/a', success: false, message: String(error) };
  }
}

async function setupCodex(dryRun: boolean, serverConfig: ServerLaunchConfig): Promise<SetupResult> {
  const provider = 'Codex CLI';
  try {
    const checkResult = await runCommand({
      command: 'codex',
      args: ['--version'],
      timeout: 10_000,
    });

    if (checkResult.exitCode !== 0) {
      return { provider, method: 'n/a', success: false, message: 'Codex CLI not installed' };
    }

    if (dryRun) {
      console.log(`Would run: codex mcp add comparo -- ${formatCommand(serverConfig)}`);
      return { provider, method: 'cli', success: true, message: 'Would configure via CLI' };
    }

    const result = await addOrReplace({
      addCommand: 'codex',
      addArgs: ['mcp', 'add', 'comparo', '--', serverConfig.command, ...serverConfig.args],
      removeCommand: 'codex',
      removeArgs: ['mcp', 'remove', 'comparo'],
    });

    if (result === true) {
      return { provider, method: 'cli', success: true, message: 'Configured via codex mcp add' };
    }

    if (result === 'replaced') {
      return { provider, method: 'cli', success: true, message: 'Replaced existing Codex MCP config' };
    }

    const finalAttempt = await runCommand({
      command: 'codex',
      args: ['mcp', 'add', 'comparo', '--', serverConfig.command, ...serverConfig.args],
      timeout: 15_000,
    });
    logger.warn(`codex mcp add failed: ${finalAttempt.stderr}`);
    return { provider, method: 'cli', success: false, message: `Failed: ${finalAttempt.stderr}` };
  } catch (error) {
    return { provider, method: 'n/a', success: false, message: String(error) };
  }
}
