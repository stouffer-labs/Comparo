import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { runCommand } from '../../../src/utils/process.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';

const mockExeca = vi.mocked(execa);

describe('runCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns normal stdout/stderr for successful commands', async () => {
    mockExeca.mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      failed: false,
    } as never);

    const result = await runCommand({
      command: 'echo',
      args: ['ok'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('');
  });

  it('maps E2BIG failures to a concise error message', async () => {
    mockExeca.mockResolvedValue({
      failed: true,
      timedOut: false,
      code: 'E2BIG',
    } as never);

    const result = await runCommand({
      command: 'claude',
      args: ['-p', 'x'],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('E2BIG: command argument list too long');
  });

  it('falls back to originalMessage when stderr is missing', async () => {
    mockExeca.mockResolvedValue({
      failed: true,
      timedOut: false,
      originalMessage: 'spawn ENOENT',
    } as never);

    const result = await runCommand({
      command: 'missing-binary',
      args: [],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('spawn ENOENT');
  });

  it('emits heartbeat activity for long-running monitored subprocesses', async () => {
    vi.useFakeTimers();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveProcess: ((value: unknown) => void) | undefined;

    const subprocess = new Promise((resolve) => {
      resolveProcess = resolve;
    }) as Promise<unknown> & {
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
    };

    subprocess.stdout = stdout;
    subprocess.stderr = stderr;
    subprocess.exitCode = null;

    mockExeca.mockReturnValue(subprocess as never);

    const onActivity = vi.fn();
    const commandPromise = runCommand({
      command: 'codex',
      args: ['exec', 'hello'],
      heartbeatIntervalMs: 1_000,
      onActivity,
    });

    await vi.advanceTimersByTimeAsync(2_500);
    subprocess.exitCode = 0;
    resolveProcess?.({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      failed: false,
    });

    const result = await commandPromise;

    expect(result.exitCode).toBe(0);
    expect(onActivity).toHaveBeenCalled();
    expect(onActivity.mock.calls.some(([event]) => event.source === 'heartbeat')).toBe(true);
    vi.useRealTimers();
  });
});
