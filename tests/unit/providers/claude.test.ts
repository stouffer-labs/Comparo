import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeAdapter } from '../../../src/providers/claude.js';
import * as fileOps from '../../../src/utils/file-ops.js';

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';

const mockExeca = vi.mocked(execa);

describe('ClaudeAdapter', () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ClaudeAdapter({ command: 'claude', maxTurns: 5, timeout: 30_000 });
  });

  describe('diagnose', () => {
    it('returns installed when claude --version succeeds', async () => {
      mockExeca.mockResolvedValue({
        stdout: '1.0.0',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      } as never);

      const result = await adapter.diagnose();
      expect(result.installed).toBe(true);
      expect(result.version).toBe('1.0.0');
    });

    it('returns not installed when command fails', async () => {
      mockExeca.mockRejectedValue(new Error('ENOENT'));

      const result = await adapter.diagnose();
      expect(result.installed).toBe(false);
    });
  });

  describe('invoke', () => {
    it('passes correct args for review mode', async () => {
      mockExeca.mockResolvedValue({
        stdout: JSON.stringify({
          result: { content: [{ type: 'text', text: 'Review feedback here' }] },
        }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      } as never);

      const response = await adapter.invoke({
        prompt: 'Review this code',
        excludeComparoMcp: true,
      });

      expect(response.text).toBe('Review feedback here');
      expect(response.provider).toBe('claude');
      expect(response.exitCode).toBe(0);

      // Verify args include --tools whitelist
      const call = mockExeca.mock.calls[0];
      const args = call[1] as string[];
      expect(args).toContain('--tools');
      expect(args).toContain('--no-session-persistence');
      expect(args).toContain('--strict-mcp-config');
    });

    it('handles timeout', async () => {
      mockExeca.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 1,
        timedOut: true,
      } as never);

      const response = await adapter.invoke({ prompt: 'test' });
      expect(response.timedOut).toBe(true);
    });

    it('handles non-zero exit code', async () => {
      mockExeca.mockResolvedValue({
        stdout: '',
        stderr: 'Authentication failed',
        exitCode: 1,
        timedOut: false,
      } as never);

      const response = await adapter.invoke({ prompt: 'test' });
      expect(response.error).toContain('Authentication failed');
    });

    it('handles JSON parse failure gracefully', async () => {
      mockExeca.mockResolvedValue({
        stdout: 'Not valid JSON but still useful output',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      } as never);

      const response = await adapter.invoke({ prompt: 'test' });
      expect(response.text).toBe('Not valid JSON but still useful output');
      expect(response.error).toContain('JSON parse failed');
    });

    it('sets COMPARO_IS_REVIEWER env var', async () => {
      mockExeca.mockResolvedValue({
        stdout: '{}',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      } as never);

      await adapter.invoke({ prompt: 'test' });

      const call = mockExeca.mock.calls[0];
      const opts = call[2] as Record<string, unknown>;
      const env = opts.env as Record<string, string>;
      expect(env.COMPARO_IS_REVIEWER).toBe('1');
    });

    it('retries via bcc when plain claude reports login is required', async () => {
      mockExeca
        .mockResolvedValueOnce({
          stdout: '{"is_error":true,"result":"Not logged in · Please run /login"}',
          stderr: 'Command failed with exit code 1: claude -p test',
          exitCode: 1,
          timedOut: false,
          failed: true,
        } as never)
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            result: { content: [{ type: 'text', text: 'Review feedback via bcc' }] },
          }),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        } as never);

      const response = await adapter.invoke({ prompt: 'test' });

      expect(response.text).toBe('Review feedback via bcc');
      expect(mockExeca.mock.calls[0]?.[0]).toBe('claude');
      expect(mockExeca.mock.calls[1]?.[0]).toBe('bcc');
      expect(mockExeca.mock.calls[1]?.[1]).toContain('--');
    });

    it('falls back for absolute-path claude commands and preserves total duration', async () => {
      adapter = new ClaudeAdapter({ command: '/opt/homebrew/bin/claude', timeout: 30_000 });

      mockExeca
        .mockResolvedValueOnce({
          stdout: '{"is_error":true,"result":"Not logged in · Please run /login"}',
          stderr: 'Command failed with exit code 1: /opt/homebrew/bin/claude -p test',
          exitCode: 1,
          timedOut: false,
          failed: true,
        } as never)
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            result: { content: [{ type: 'text', text: 'Fallback worked' }] },
          }),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        } as never);

      const response = await adapter.invoke({ prompt: 'test', timeout: 30_000 });

      expect(response.text).toBe('Fallback worked');
      expect(mockExeca.mock.calls[0]?.[0]).toBe('/opt/homebrew/bin/claude');
      expect(mockExeca.mock.calls[1]?.[0]).toBe('bcc');
    });

    it('skips bcc fallback when too little timeout remains', async () => {
      adapter = new ClaudeAdapter({ command: 'claude', timeout: 1 });

      mockExeca.mockResolvedValueOnce({
        stdout: '{"is_error":true,"result":"Not logged in · Please run /login"}',
        stderr: 'Command failed with exit code 1: claude -p test',
        exitCode: 1,
        timedOut: false,
        failed: true,
      } as never);

      const response = await adapter.invoke({ prompt: 'test', timeout: 1 });

      expect(response.timedOut).toBe(true);
      expect(mockExeca).toHaveBeenCalledTimes(1);
    });

    it('uses file handoff for oversized invokeViaFile payloads', async () => {
      const largeContent = 'A'.repeat(300_000);
      vi.spyOn(fileOps, 'readTextFile').mockResolvedValueOnce(largeContent);

      mockExeca.mockResolvedValue({
        stdout: JSON.stringify({
          result: { content: [{ type: 'text', text: 'ok' }] },
        }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      } as never);

      await adapter.invokeViaFile('/tmp/review-request.md', {
        excludeComparoMcp: true,
        depth: 'quick',
      });

      const call = mockExeca.mock.calls[0];
      const args = call[1] as string[];
      const promptArg = args[args.indexOf('-p') + 1];

      expect(promptArg).toContain('/tmp/review-request.md');
      expect(promptArg.length).toBeLessThan(300_000);
      expect(args).toContain('--max-turns');
      expect(args).toContain('5');
      expect(args).toContain('--tools');
      expect(args).toContain('Read');
    });
  });
});
