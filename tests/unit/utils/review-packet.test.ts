import { describe, it, expect } from 'vitest';
import { generateReviewPacket } from '../../../src/utils/review-packet.js';
import type { ReviewRequest } from '../../../src/types.js';

describe('generateReviewPacket', () => {
  it('truncates oversized quick-mode context for speed', () => {
    const request: ReviewRequest = {
      context: 'A'.repeat(200_000),
      question: 'Assess this quickly',
      reviewers: ['claude'],
      depth: 'quick',
    };

    const packet = generateReviewPacket(request);

    expect(packet).toContain('NOTE: Quick mode context was truncated for speed');
    expect(packet).toContain('--- CONTEXT (TRUNCATED MIDDLE OMITTED) ---');
    expect(packet.length).toBeLessThan(request.context.length);
  });

  it('keeps full context for thorough mode', () => {
    const context = 'B'.repeat(120_000);
    const request: ReviewRequest = {
      context,
      question: 'Assess thoroughly',
      reviewers: ['claude'],
      depth: 'thorough',
    };

    const packet = generateReviewPacket(request);

    expect(packet).not.toContain('Quick mode context was truncated');
    expect(packet).toContain(context);
  });

  it('includes the deep-review best-effort timebox guidance', () => {
    const request: ReviewRequest = {
      context: 'Context',
      question: 'Assess thoroughly',
      reviewers: ['claude'],
      depth: 'thorough',
    };

    const packet = generateReviewPacket(request);

    expect(packet).toContain('8-15 minutes');
    expect(packet).toContain('Keep web research high-signal');
  });
});
