import { execa, type ResultPromise } from 'execa';
import { logger } from './logger.js';
import type { ProviderActivityEvent } from '../types.js';

const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024; // 50MB
const MAX_ERROR_MESSAGE = 4000;

export interface RunCommandOptions {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeout?: number;
  input?: string;
  maxBuffer?: number;
  heartbeatIntervalMs?: number;
  onActivity?: (event: ProviderActivityEvent) => void | Promise<void>;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

interface ExecaOutcome {
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
  timedOut?: unknown;
  failed?: unknown;
  code?: unknown;
  shortMessage?: unknown;
  originalMessage?: unknown;
}

export async function runCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  const start = Date.now();

  const filteredEnv: Record<string, string> = {};
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (value !== undefined) {
        filteredEnv[key] = value;
      }
    }
  }

  const processEnv = { ...process.env, ...filteredEnv };
  // If a key was explicitly set to undefined in opts.env, delete it
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (value === undefined) {
        delete processEnv[key];
      }
    }
  }

  try {
    logger.debug(`Running: ${opts.command} ${opts.args.join(' ')}`);

    const subprocess: ResultPromise & {
      stdout?: NodeJS.ReadableStream;
      stderr?: NodeJS.ReadableStream;
      exitCode?: number | null;
    } = execa(opts.command, opts.args, {
      env: processEnv,
      extendEnv: false, // We build the full env ourselves; prevent re-merging process.env
      stdin: opts.input !== undefined ? undefined : 'ignore', // Detach stdin unless providing input
      cwd: opts.cwd,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      input: opts.input,
      reject: false,
      stripFinalNewline: true,
    });

    let streamedStdout = '';
    let streamedStderr = '';
    let heartbeatTimer: NodeJS.Timeout | undefined;

    const emitActivity = (source: ProviderActivityEvent['source']) => {
      if (!opts.onActivity) return;
      void opts.onActivity({
        source,
        timestamp: Date.now(),
      });
    };

    if (subprocess.stdout) {
      subprocess.stdout.on('data', (chunk: Buffer | string) => {
        streamedStdout += String(chunk);
        emitActivity('stdout');
      });
    }

    if (subprocess.stderr) {
      subprocess.stderr.on('data', (chunk: Buffer | string) => {
        streamedStderr += String(chunk);
        emitActivity('stderr');
      });
    }

    if (opts.heartbeatIntervalMs && opts.onActivity) {
      emitActivity('heartbeat');
      heartbeatTimer = setInterval(() => {
        if (subprocess.exitCode === null || subprocess.exitCode === undefined) {
          emitActivity('heartbeat');
        }
      }, opts.heartbeatIntervalMs);
    }

    const result = (await subprocess) as ExecaOutcome;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const stderr = getErrorText(result);
    const failed = result.failed === true;
    const exitCode = typeof result.exitCode === 'number'
      ? result.exitCode
      : (failed ? 1 : 0);

    return {
      stdout: streamedStdout || (typeof result.stdout === 'string' ? result.stdout : ''),
      stderr: streamedStderr || stderr,
      exitCode,
      timedOut: result.timedOut === true,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    if (error && typeof error === 'object') {
      // no-op, but keeps parity with the success path if a monitored command throws
    }
    const err = error as Error & ExecaOutcome;
    const stderr = getErrorText(err) || 'Unknown process error';
    return {
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr,
      exitCode: typeof err.exitCode === 'number' ? err.exitCode : 1,
      timedOut: err.timedOut === true,
      durationMs: Date.now() - start,
    };
  }
}

function getErrorText(result: ExecaOutcome): string {
  if (typeof result.stderr === 'string' && result.stderr.trim()) {
    return result.stderr;
  }

  if (result.code === 'E2BIG') {
    return 'E2BIG: command argument list too long';
  }

  if (typeof result.originalMessage === 'string' && result.originalMessage.trim()) {
    return truncate(result.originalMessage);
  }

  if (typeof result.shortMessage === 'string' && result.shortMessage.trim()) {
    return truncate(result.shortMessage);
  }

  if (typeof result.code === 'string' && result.code.trim()) {
    return `Process failed with code ${result.code}`;
  }

  return '';
}

function truncate(text: string): string {
  if (text.length <= MAX_ERROR_MESSAGE) return text;
  return `${text.slice(0, MAX_ERROR_MESSAGE)}...`;
}
