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
import { readTextFile } from '../../../src/utils/file-ops.js';

const mockRunCommand = vi.mocked(runCommand);
const mockReadTextFile = vi.mocked(readTextFile);

// Build a codex `--json` JSONL stdout stream from a compact event spec.
// Mirrors the real cli 0.136.0 shape: thread.started / turn.started /
// item.completed{item:{type,text|...}} / turn.completed{usage}.
function buildStream(
  items: Array<{ kind: 'msg'; text: string } | { kind: 'tool' }>,
  outputTokens: number,
): string {
  const lines: string[] = [
    JSON.stringify({ type: 'thread.started', thread_id: 'test-thread' }),
    JSON.stringify({ type: 'turn.started' }),
  ];
  for (const it of items) {
    if (it.kind === 'msg') {
      lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: it.text } }));
    } else {
      lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 's', tool: 't', status: 'completed' } }));
    }
  }
  lines.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: outputTokens, reasoning_output_tokens: 0 } }));
  return lines.join('\n');
}

function okResult(stdout: string) {
  return { stdout, stderr: '', exitCode: 0, timedOut: false, durationMs: 1_000 };
}

describe('CodexAdapter', () => {
  let adapter: CodexAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: output-last-message file is EMPTY so parsing falls to the stream.
    // (Individual tests that exercise the output-file path override this.)
    mockReadTextFile.mockResolvedValue('');
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

  it('uses --sandbox (not the deprecated --full-auto) and maps safeMode to the sandbox value', async () => {
    mockRunCommand.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false, durationMs: 1_000 });

    // Default (not safe) → workspace-write (the exact behavior --full-auto expanded to).
    await adapter.invoke({ prompt: 'q', timeout: 30_000 });
    let args = (mockRunCommand.mock.calls[0]?.[0] as { args: string[] }).args;
    expect(args).not.toContain('--full-auto'); // deprecated alias must be gone
    expect(args).toContain('--sandbox');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    // Exactly one sandbox flag (no conflicting double-spec).
    expect(args.filter((a) => a === '--sandbox')).toHaveLength(1);
    expect(args).not.toContain('-s');

    // safeMode → read-only.
    mockRunCommand.mockClear();
    await adapter.invoke({ prompt: 'q', timeout: 30_000, safeMode: true });
    args = (mockRunCommand.mock.calls[0]?.[0] as { args: string[] }).args;
    expect(args).not.toContain('--full-auto');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args.filter((a) => a === '--sandbox')).toHaveLength(1);
  });

  it('extracts the last agent_message from the JSON stream (modern item.completed shape)', async () => {
    const stdout = buildStream(
      [
        { kind: 'msg', text: 'early narration' },
        { kind: 'tool' },
        { kind: 'msg', text: 'FINAL SYNTHESIS' },
      ],
      5000,
    );
    mockRunCommand.mockResolvedValue(okResult(stdout));

    const res = await adapter.invoke({ prompt: 'q', timeout: 30_000 });

    expect(res.text).toBe('FINAL SYNTHESIS');
    expect(res.incomplete).toBeFalsy();
    expect(res.error).toBeUndefined();
    // rawJson is the parsed event array
    expect(Array.isArray(res.rawJson)).toBe(true);
  });

  it('flags INCOMPLETE when the turn ends with tool calls after the last agent_message', async () => {
    // Mirrors real run 054444: narrate, then run tools, then turn.completed with no closing message.
    const stdout = buildStream(
      [
        { kind: 'msg', text: 'I will verify via tools' },
        { kind: 'tool' },
        { kind: 'msg', text: 'mid-stream narration, not a synthesis' },
        { kind: 'tool' },
        { kind: 'tool' },
      ],
      2259,
    );
    mockRunCommand.mockResolvedValue(okResult(stdout));

    const res = await adapter.invoke({ prompt: 'q', timeout: 30_000 });

    // Must NOT surface the narration as the answer.
    expect(res.incomplete).toBe(true);
    expect(res.text).toBe('');
    expect(res.error).toMatch(/incomplete|final|synthesis/i);
    // Full stream preserved for recovery/debugging.
    expect(Array.isArray(res.rawJson)).toBe(true);
  });

  it('flags INCOMPLETE on a genuinely empty turn (zero agent_messages, 0 output tokens)', async () => {
    // Mirrors real run 053945.
    const stdout = buildStream([], 0);
    mockRunCommand.mockResolvedValue(okResult(stdout));

    const res = await adapter.invoke({ prompt: 'q', timeout: 30_000 });

    expect(res.incomplete).toBe(true);
    expect(res.text).toBe('');
    expect(res.error).toMatch(/incomplete|empty|no final/i);
  });

  it('NEVER returns raw stream output as the answer when no agent_message exists', async () => {
    // The old fallback returned `text || stdout`, surfacing raw JSONL as a
    // "successful" non-empty response. Guard against that regression.
    const stdout = buildStream([{ kind: 'tool' }], 50);
    mockRunCommand.mockResolvedValue(okResult(stdout));

    const res = await adapter.invoke({ prompt: 'q', timeout: 30_000 });

    expect(res.text).not.toContain('thread.started');
    expect(res.text).not.toContain('turn.completed');
    expect(res.incomplete).toBe(true);
  });

  it('prefers the --output-last-message file only when it is a real final message', async () => {
    // When the output file holds the genuine last synthesis AND the stream agrees
    // it was the final item, return it normally.
    const stdout = buildStream([{ kind: 'msg', text: 'FINAL SYNTHESIS' }], 4000);
    mockReadTextFile.mockResolvedValue('FINAL SYNTHESIS');
    mockRunCommand.mockResolvedValue(okResult(stdout));

    const res = await adapter.invoke({ prompt: 'q', timeout: 30_000 });

    expect(res.text).toBe('FINAL SYNTHESIS');
    expect(res.incomplete).toBeFalsy();
  });

  // ---- Upstream backend UNAVAILABILITY (Bedrock outage) ----
  // Real signature: codex retries the stream up to 5x then ends in turn.failed.

  it('flags UNAVAILABLE when the stream disconnects repeatedly and the turn fails', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      ...[1, 2, 3, 4, 5].map((n) =>
        JSON.stringify({ type: 'error', message: `Reconnecting... ${n}/5 (stream disconnected before completion: The server had an error while processing your request. Sorry about that!)` }),
      ),
      JSON.stringify({ type: 'turn.failed' }),
    ];
    mockRunCommand.mockResolvedValue(okResult(lines.join('\n')));

    const res = await adapter.invoke({ prompt: 'q', timeout: 30_000 });

    expect(res.unavailable).toBe(true);
    expect(res.incomplete).toBe(true);
    expect(res.text).toBe('');
    expect(res.error).toMatch(/unavailable|skipped|backend|outage/i);
  });

  it('flags UNAVAILABLE on "Exceeded on-demand capacity" with no completion', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: Exceeded on-demand capacity. Please try again later.)' }),
      JSON.stringify({ type: 'turn.failed' }),
    ];
    mockRunCommand.mockResolvedValue(okResult(lines.join('\n')));

    const res = await adapter.invoke({ prompt: 'q', timeout: 30_000 });

    expect(res.unavailable).toBe(true);
    expect(res.error).toMatch(/capacity|unavailable|skipped/i);
  });

  it('flags UNAVAILABLE on a 404 "Engine not found" (model slug not served), surfacing the real message', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'error', message: 'Task submission failed with status 404 Not Found: Engine not found' }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'Task submission failed with status 404 Not Found: Engine not found' } }),
    ];
    mockRunCommand.mockResolvedValue(okResult(lines.join('\n')));

    const res = await adapter.invoke({ prompt: 'q', timeout: 30_000 });

    expect(res.unavailable).toBe(true);
    expect(res.text).toBe('');
    // The surfaced reason should include the real 404 text, not just the generic fallback.
    expect(res.error).toMatch(/Engine not found|404/i);
  });

  it('does NOT flag unavailable when a transient reconnect recovers and the turn completes', async () => {
    // A single mid-stream reconnect that then succeeds must NOT be treated as an outage.
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: The server had an error)' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'REAL ANSWER after a blip' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }),
    ];
    mockRunCommand.mockResolvedValue(okResult(lines.join('\n')));

    const res = await adapter.invoke({ prompt: 'q', timeout: 30_000 });

    expect(res.unavailable).toBeFalsy();
    expect(res.incomplete).toBeFalsy();
    expect(res.text).toBe('REAL ANSWER after a blip');
  });
});
