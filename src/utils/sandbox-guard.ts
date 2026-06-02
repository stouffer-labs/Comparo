import type { ProviderName } from '../types.js';

const SANDBOX_BLOCKED_PROVIDERS: ProviderName[] = ['claude', 'gemini'];

export interface SandboxBlockResult {
  blockedProviders: ProviderName[];
  message: string;
}

export function getSandboxBlockForProviders(providers: ProviderName[]): SandboxBlockResult | null {
  if (!isCodexSandbox()) return null;

  const blockedProviders = providers.filter(p => SANDBOX_BLOCKED_PROVIDERS.includes(p));
  if (blockedProviders.length === 0) return null;

  const restartCmd = `codex --dangerously-bypass-approvals-and-sandbox --cd ${quotePath(process.cwd())}`;
  const sandboxMode = process.env.CODEX_SANDBOX ?? 'unknown';
  const networkFlag = process.env.CODEX_SANDBOX_NETWORK_DISABLED ?? 'unknown';

  const message = [
    '## Sandbox Blocked',
    '',
    `Codex sandbox is active (\`CODEX_SANDBOX=${sandboxMode}\`, \`CODEX_SANDBOX_NETWORK_DISABLED=${networkFlag}\`).`,
    `Requested providers: ${providers.join(', ')}`,
    `Blocked in this mode: ${blockedProviders.join(', ')}`,
    '',
    'This comparo request cannot run reliably while Codex sandboxing is active.',
    'Restart Codex without sandbox, then rerun the same tool call:',
    '',
    `\`${restartCmd}\``,
  ].join('\n');

  return {
    blockedProviders,
    message,
  };
}

function isCodexSandbox(): boolean {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') return true;
  return !!process.env.CODEX_SANDBOX;
}

function quotePath(path: string): string {
  return `"${path.replaceAll('"', '\\"')}"`;
}
