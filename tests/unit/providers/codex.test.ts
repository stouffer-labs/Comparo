import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/process.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('../../../src/utils/file-ops.js', () => ({
  getTempFilePath: vi.fn().mockReturnValue('/mock/.comparo/codex-output.txt'),
  readTextFile: vi.fn().mockResolvedValue('Codex answer'),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  getComparoDir: vi.fn().mockReturnValue('/mock/.comparo'),
}));

import { CodexAdapter } from '../../../src/providers/codex.js';
import { runCommand } from '../../../src/utils/process.js';

const mockRunCommand = vi.mocked(runCommand);

describe('CodexAdapter', () => {
  let adapter: CodexAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new CodexAdapter({ command: 'codex', timeout: 30_000 });
  });

  it('on Windows, sends a small prompt via stdin (not argv) to avoid the cmd.exe shim', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      mockRunCommand.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 1_000,
      });

      // A short prompt that would normally take the argv path on non-Windows.
      await adapter.invoke({ prompt: 'tiny prompt', timeout: 30_000 });

      const opts = mockRunCommand.mock.calls[0]?.[0] as {
        args: string[];
        input?: string;
      };
      // Prompt arg must be `-` (stdin marker), and the prompt is piped as input.
      expect(opts.args).toContain('-');
      expect(opts.args).not.toContain('tiny prompt');
      expect(opts.input).toBe('tiny prompt');
      // The git flag must survive — it was being dropped by cmd.exe mangling.
      expect(opts.args).toContain('--skip-git-repo-check');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('uses heartbeat-based execution instead of a wall-clock timeout', async () => {
    const onActivity = vi.fn();
    mockRunCommand.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 1_000,
    });

    await adapter.invoke({
      prompt: 'Investigate this architecture deeply',
      timeout: 900_000,
      onActivity,
    });

    const opts = mockRunCommand.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.timeout).toBeUndefined();
    expect(opts.heartbeatIntervalMs).toBe(30_000);
    expect(opts.onActivity).toBe(onActivity);
  });
});
