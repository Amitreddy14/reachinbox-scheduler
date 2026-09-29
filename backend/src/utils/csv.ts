const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export interface ParsedLeads {
  emails: string[];
  duplicates: number;
  invalidLines: number;
}

/**
 * Lead lists arrive as CSV exports, one-per-line text files or a pasted blob,
 * with or without a header row. Rather than guessing the column layout we scan
 * for anything shaped like an address, lowercase it and de-duplicate. That
 * handles "name,email,company" and a bare list with the same code path.
 */
export function extractEmails(raw: string): ParsedLeads {
  const seen = new Set<string>();
  const emails: string[] = [];
  let duplicates = 0;
  let invalidLines = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const matches = trimmed.match(EMAIL_PATTERN);
    if (!matches) {
      invalidLines += 1;
      continue;
    }

    for (const match of matches) {
      const normalised = match.toLowerCase();
      if (seen.has(normalised)) {
        duplicates += 1;
        continue;
      }
      seen.add(normalised);
      emails.push(normalised);
    }
  }

  return { emails, duplicates, invalidLines };
}

export function isValidEmail(value: string): boolean {
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.trim());
}

/** Very small HTML -> text reduction, enough for the plain-text MIME part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
