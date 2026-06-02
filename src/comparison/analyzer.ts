import type { ProviderName, ProviderResponse, ComparisonSection, ComparisonResult } from '../types.js';

const KNOWN_SECTIONS = [
  'My Assessment',
  'Agreements',
  'Disagreements',
  'Risks',
  'Recommendations',
];

export function analyzeResponses(
  question: string,
  responses: ProviderResponse[],
  failed: Array<{ provider: ProviderName; error: string }>,
): ComparisonResult {
  const sections = extractSections(responses);

  return {
    question,
    responses,
    failed,
    sections,
  };
}

function extractSections(responses: ProviderResponse[]): ComparisonSection[] {
  const sections: ComparisonSection[] = [];

  for (const sectionName of KNOWN_SECTIONS) {
    const entries: Partial<Record<ProviderName, string>> = {};

    for (const response of responses) {
      if (response.error && !response.text) continue;
      const content = extractSection(response.text, sectionName);
      if (content) {
        entries[response.provider] = content;
      }
    }

    if (Object.keys(entries).length > 0) {
      sections.push({
        name: sectionName,
        entries: entries as Record<ProviderName, string>,
      });
    }
  }

  // If no structured sections found, create a single "Full Response" section
  if (sections.length === 0) {
    const entries: Partial<Record<ProviderName, string>> = {};
    for (const response of responses) {
      if (response.text) {
        entries[response.provider] = response.text;
      }
    }
    if (Object.keys(entries).length > 0) {
      sections.push({
        name: 'Full Response',
        entries: entries as Record<ProviderName, string>,
      });
    }
  }

  return sections;
}

function extractSection(text: string, sectionName: string): string | null {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Try multiple header formats LLMs might produce:
  // 1. ### Section Name  or  ## Section Name
  // 2. ### 1. Section Name  (numbered)
  // 3. **Section Name**  or  **Section Name:**
  const patterns = [
    new RegExp(`^#{1,4}\\s+(?:\\d+\\.\\s+)?${escaped}\\s*:?\\s*$`, 'im'),
    new RegExp(`^\\*\\*${escaped}\\s*:?\\*\\*\\s*$`, 'im'),
  ];

  let match: RegExpExecArray | null = null;
  for (const pattern of patterns) {
    match = pattern.exec(text);
    if (match) break;
  }
  if (!match) return null;

  const startIdx = match.index + match[0].length;
  const remaining = text.slice(startIdx);

  // Find the next section-like header (markdown heading or bold line)
  const nextHeader = /^(?:#{1,4}\s+|\*\*[A-Z])/m;
  const nextMatch = nextHeader.exec(remaining);

  const content = nextMatch
    ? remaining.slice(0, nextMatch.index).trim()
    : remaining.trim();

  return content || null;
}
