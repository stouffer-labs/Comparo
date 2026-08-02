import { z } from 'zod';

// Codex is the only reviewer this install consults. Narrowing the enum here is
// what enforces it: the MCP tool schemas are generated from these shapes, so a
// caller cannot even ask for claude or gemini. The claude/gemini adapters and
// their config entries stay in the tree, dormant — widen this enum to re-enable.
export const ProviderNameSchema = z.enum(['codex']);

export const ReviewInputSchema = z.object({
  context: z.string().describe('Full context of what is being reviewed'),
  question: z.string().describe('Specific question for reviewers'),
  reviewers: z.array(ProviderNameSchema).min(1).default(['codex']).describe('Which AIs to consult. Only ["codex"] is available.'),
  contextFiles: z.array(z.string()).optional().describe('File paths reviewers should read'),
});

export const RaceInputSchema = z.object({
  prompt: z.string().describe('Same prompt sent to all models'),
  models: z.array(ProviderNameSchema).min(1).default(['codex']).describe('Which AIs to race. Only ["codex"] is available.'),
});

export const CheckInputSchema = z.object({
  runId: z.string().optional().describe('Run ID from a previous comparo_review or comparo_race call. If omitted, checks the most recent job.'),
});

export const ConsolidateInputSchema = z.object({
  context: z.string().describe('Session context to consolidate'),
  format: z.enum(['transfer_packet', 'prompt']).describe('Output format'),
});

export const ProviderConfigSchema = z.object({
  command: z.string(),
  maxTurns: z.number().optional(),
  timeout: z.number().optional(),
});

export const ComparoConfigSchema = z.object({
  providers: z.object({
    claude: ProviderConfigSchema,
    gemini: ProviderConfigSchema,
    codex: ProviderConfigSchema,
  }),
  defaults: z.object({
    timeout: z.number(),
    maxTurns: z.number(),
    maxRuns: z.number(),
  }),
  safeMode: z.boolean().optional(),
});
