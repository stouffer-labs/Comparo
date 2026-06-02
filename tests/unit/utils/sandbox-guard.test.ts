import { afterEach, describe, expect, it } from 'vitest';
import { getSandboxBlockForProviders } from '../../../src/utils/sandbox-guard.js';

const originalSandbox = process.env.CODEX_SANDBOX;
const originalNetworkDisabled = process.env.CODEX_SANDBOX_NETWORK_DISABLED;

afterEach(() => {
  if (originalSandbox === undefined) {
    delete process.env.CODEX_SANDBOX;
  } else {
    process.env.CODEX_SANDBOX = originalSandbox;
  }

  if (originalNetworkDisabled === undefined) {
    delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  } else {
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = originalNetworkDisabled;
  }
});

describe('sandbox guard', () => {
  it('blocks claude/gemini requests when codex sandbox is active', () => {
    process.env.CODEX_SANDBOX = 'seatbelt';
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = '1';

    const result = getSandboxBlockForProviders(['claude']);

    expect(result).not.toBeNull();
    expect(result?.blockedProviders).toEqual(['claude']);
    expect(result?.message).toContain('Sandbox Blocked');
    expect(result?.message).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('allows codex-only requests even in sandbox mode', () => {
    process.env.CODEX_SANDBOX = 'seatbelt';
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = '1';

    const result = getSandboxBlockForProviders(['codex']);

    expect(result).toBeNull();
  });

  it('allows all providers when no codex sandbox vars are set', () => {
    delete process.env.CODEX_SANDBOX;
    delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;

    const result = getSandboxBlockForProviders(['claude', 'gemini']);

    expect(result).toBeNull();
  });
});
