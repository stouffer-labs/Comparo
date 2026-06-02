import type { ReviewRequest } from '../types.js';

const QUICK_CONTEXT_MAX_CHARS = 20_000;
const QUICK_CONTEXT_HEAD_CHARS = 14_000;
const QUICK_CONTEXT_TAIL_CHARS = 5_000;

const QUICK_GUIDELINES = [
  'Guidelines:',
  "- Don't just agree with the other AI's work — critically evaluate it",
  '- Read the referenced files directly to verify claims',
  '- Be specific: cite file names, line numbers, and concrete issues',
  '- If something looks correct, say so and explain why',
  '- If something looks wrong or risky, explain the issue clearly',
  '- Prioritize the provided context and local files; avoid web research for quick mode',
  '- Provide a best-effort assessment quickly, even if evidence is incomplete',
];

const THOROUGH_GUIDELINES = [
  'Guidelines:',
  "- Don't just agree with the other AI's work — critically evaluate it",
  '- Read the referenced files directly to verify claims',
  '- Be specific: cite file names, line numbers, and concrete issues',
  '- If something looks correct, say so and explain why',
  '- If something looks wrong or risky, explain the issue clearly',
  '- Research claims thoroughly — use web searches to verify against primary sources and official documentation',
  '- Cross-reference multiple sources when claims involve pricing, specifications, or technical capabilities',
  '- Aim for a decisive best-effort answer within about 8-15 minutes rather than exhaustive open-ended exploration',
  '- Keep web research high-signal: prioritize the most relevant primary sources over broad search sprees',
];

export function generateReviewPacket(request: ReviewRequest): string {
  const guidelines = request.depth === 'thorough' ? THOROUGH_GUIDELINES : QUICK_GUIDELINES;
  const context = getContextForPacket(request);

  const lines: string[] = [
    '# Independent Review Request',
    '',
    '## Instructions',
    '',
    'You are an independent reviewer. Another AI has been working on a project and is requesting your independent assessment. Your job is to provide honest, thorough feedback.',
    '',
    ...guidelines,
    '',
    '## Question',
    '',
    request.question,
    '',
    '## Context',
    '',
    context,
    '',
  ];

  if (request.contextFiles && request.contextFiles.length > 0) {
    lines.push('## Files to Review', '');
    for (const file of request.contextFiles) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }

  lines.push(
    '## Expected Response Format',
    '',
    'Please structure your response with these sections:',
    '',
    '### My Assessment',
    'Your overall assessment of the work.',
    '',
    '### Agreements',
    'What you agree with and why.',
    '',
    '### Disagreements',
    "What you disagree with and why. Be specific about what's wrong and what should be done instead.",
    '',
    '### Risks',
    'Potential risks, edge cases, or issues not addressed.',
    '',
    '### Recommendations',
    'Specific, actionable recommendations for improvement.',
  );

  return lines.join('\n');
}

function getContextForPacket(request: ReviewRequest): string {
  if (request.depth !== 'quick') return request.context;
  if (request.context.length <= QUICK_CONTEXT_MAX_CHARS) return request.context;

  const head = request.context.slice(0, QUICK_CONTEXT_HEAD_CHARS);
  const tail = request.context.slice(-QUICK_CONTEXT_TAIL_CHARS);

  return [
    `NOTE: Quick mode context was truncated for speed (${request.context.length.toLocaleString()} chars -> ${QUICK_CONTEXT_MAX_CHARS.toLocaleString()} chars budget).`,
    'The following includes the beginning and end of the provided context.',
    '',
    '--- CONTEXT (START) ---',
    head,
    '',
    '--- CONTEXT (TRUNCATED MIDDLE OMITTED) ---',
    '',
    '--- CONTEXT (END) ---',
    tail,
  ].join('\n');
}
