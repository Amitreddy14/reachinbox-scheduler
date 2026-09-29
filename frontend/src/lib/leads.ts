const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export interface ParsedLeads {
  emails: string[];
  duplicates: number;
  skippedLines: number;
}

/**
 * Lead lists arrive as CSV exports, one-address-per-line text files or a pasted
 * blob, with or without a header row. Rather than guessing the column layout we
 * scan every line for anything shaped like an address, lowercase it and
 * de-duplicate — one code path for "name,email,company" and for a bare list.
 *
 * Parsing happens in the browser so the recipient count appears the instant the
 * file is chosen; the backend re-validates the list it is actually given.
 */
export function parseLeads(raw: string): ParsedLeads {
  const seen = new Set<string>();
  const emails: string[] = [];
  let duplicates = 0;
  let skippedLines = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const matches = trimmed.match(EMAIL_PATTERN);
    if (!matches) {
      skippedLines += 1;
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

  return { emails, duplicates, skippedLines };
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}
