import type { ComparisonResult, ProviderResponse, ProviderName } from '../types.js';

export function formatComparison(result: ComparisonResult): string {
  const lines: string[] = [];

  lines.push('## Cross-Validation Report');
  lines.push('');

  // Question
  lines.push('### Question');
  lines.push('');
  lines.push(result.question);
  lines.push('');

  // Reviewers
  const successful = result.responses.filter(r => !r.error || r.text);
  if (successful.length > 0) {
    lines.push('### Reviewers');
    lines.push('');
    for (const r of successful) {
      lines.push(`- **${r.provider}** (${formatDuration(r.durationMs)})`);
    }
    lines.push('');
  }

  // Failed reviewers
  if (result.failed.length > 0) {
    lines.push('### Failed Reviewers');
    lines.push('');
    for (const f of result.failed) {
      lines.push(`- **${f.provider}**: ${f.error}`);
    }
    lines.push('');
  }

  // Structured comparison
  if (result.sections.length > 0) {
    lines.push('### Structured Comparison');
    lines.push('');

    for (const section of result.sections) {
      lines.push(`#### ${section.name}`);
      lines.push('');

      for (const [provider, content] of Object.entries(section.entries)) {
        lines.push(`**${provider}:**`);
        lines.push(content);
        lines.push('');
      }
    }
  }

  // Full responses in collapsible sections
  lines.push('### Full Responses');
  lines.push('');

  for (const r of result.responses) {
    if (!r.text && r.error) {
      lines.push(`<details><summary>${r.provider} (FAILED)</summary>`);
      lines.push('');
      lines.push(`Error: ${r.error}`);
      lines.push('');
      lines.push('</details>');
    } else {
      lines.push(`<details><summary>${r.provider} (${formatDuration(r.durationMs)})</summary>`);
      lines.push('');
      lines.push(r.text);
      lines.push('');
      lines.push('</details>');
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatRaceResults(responses: ProviderResponse[], failed: Array<{ provider: ProviderName; error: string }>): string {
  const lines: string[] = [];

  lines.push('## Race Results');
  lines.push('');

  // Sort by duration
  const sorted = [...responses].filter(r => !r.error || r.text).sort((a, b) => a.durationMs - b.durationMs);

  if (sorted.length > 0) {
    lines.push('### Rankings');
    lines.push('');
    sorted.forEach((r, i) => {
      const medal = i === 0 ? '1st' : i === 1 ? '2nd' : `${i + 1}th`;
      lines.push(`${medal}. **${r.provider}** — ${formatDuration(r.durationMs)}`);
    });
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push('### Failed');
    lines.push('');
    for (const f of failed) {
      lines.push(`- **${f.provider}**: ${f.error}`);
    }
    lines.push('');
  }

  // Full responses
  lines.push('### Responses');
  lines.push('');

  for (const r of sorted) {
    lines.push(`<details><summary>${r.provider} (${formatDuration(r.durationMs)})</summary>`);
    lines.push('');
    lines.push(r.text);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  return lines.join('\n');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
