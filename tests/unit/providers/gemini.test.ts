import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiAdapter } from '../../../src/providers/gemini.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';

const mockExeca = vi.mocked(execa);

describe('GeminiAdapter', () => {
  let adapter: GeminiAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new GeminiAdapter({ command: 'gemini', timeout: 30_000 });
  });

  describe('diagnose', () => {
    it('returns installed when gemini --version succeeds', async () => {
      mockExeca.mockResolvedValue({
        stdout: '0.5.0',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      } as never);

      const result = await adapter.diagnose();
      expect(result.installed).toBe(true);
      expect(result.version).toBe('0.5.0');
    });
  });

  describe('invoke', () => {
    it('parses gemini response format', async () => {
      mockExeca.mockResolvedValue({
        stdout: JSON.stringify({ response: 'Gemini review content' }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      } as never);

      const response = await adapter.invoke({ prompt: 'Review this' });
      expect(response.text).toBe('Gemini review content');
      expect(response.provider).toBe('gemini');
    });

    it('passes --approval-mode yolo', async () => {
      mockExeca.mockResolvedValue({
        stdout: '{}',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      } as never);

      await adapter.invoke({ prompt: 'test' });

      const call = mockExeca.mock.calls[0];
      const args = call[1] as string[];
      expect(args).toContain('--approval-mode');
      expect(args).toContain('yolo');
    });
  });
});
