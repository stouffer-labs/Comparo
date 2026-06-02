import { describe, it, expect } from 'vitest';
import { analyzeResponses } from '../../../src/comparison/analyzer.js';
import type { ProviderResponse } from '../../../src/types.js';

describe('analyzeResponses', () => {
  it('extracts structured sections from responses', () => {
    const responses: ProviderResponse[] = [
      {
        provider: 'gemini',
        text: `### My Assessment\nLooks solid overall.\n\n### Agreements\nGood architecture.\n\n### Risks\nNo error handling for edge case X.`,
        rawJson: null,
        durationMs: 5000,
        exitCode: 0,
      },
      {
        provider: 'codex',
        text: `### My Assessment\nGenerally correct approach.\n\n### Agreements\nClean code structure.\n\n### Disagreements\nShould use a different pattern.`,
        rawJson: null,
        durationMs: 8000,
        exitCode: 0,
      },
    ];

    const result = analyzeResponses('Is this approach correct?', responses, []);

    expect(result.question).toBe('Is this approach correct?');
    expect(result.responses).toHaveLength(2);
    expect(result.failed).toHaveLength(0);

    // Should have extracted sections
    const sectionNames = result.sections.map(s => s.name);
    expect(sectionNames).toContain('My Assessment');
    expect(sectionNames).toContain('Agreements');

    const assessmentSection = result.sections.find(s => s.name === 'My Assessment');
    expect(assessmentSection?.entries.gemini).toBe('Looks solid overall.');
    expect(assessmentSection?.entries.codex).toBe('Generally correct approach.');
  });

  it('falls back to full response when no sections found', () => {
    const responses: ProviderResponse[] = [
      {
        provider: 'gemini',
        text: 'Just a plain text response with no structure.',
        rawJson: null,
        durationMs: 3000,
        exitCode: 0,
      },
    ];

    const result = analyzeResponses('Question?', responses, []);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].name).toBe('Full Response');
  });

  it('includes failed providers', () => {
    const responses: ProviderResponse[] = [
      {
        provider: 'gemini',
        text: 'Some response',
        rawJson: null,
        durationMs: 5000,
        exitCode: 0,
      },
    ];

    const failed = [{ provider: 'codex' as const, error: 'Timed out' }];
    const result = analyzeResponses('Q?', responses, failed);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].provider).toBe('codex');
  });
});
