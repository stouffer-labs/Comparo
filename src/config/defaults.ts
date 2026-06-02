import type { ComparoConfig } from '../types.js';

export const DEFAULT_CONFIG: ComparoConfig = {
  providers: {
    claude: {
      command: 'claude',
      maxTurns: 5,
      timeout: 300_000,
    },
    gemini: {
      command: 'gemini',
      maxTurns: undefined,
      timeout: 300_000,
    },
    codex: {
      command: 'codex',
      maxTurns: undefined,
      timeout: 300_000,
    },
  },
  defaults: {
    timeout: 300_000,
    maxTurns: 5,
    maxRuns: 50,
  },
  safeMode: false,
};
