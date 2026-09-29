/** Presentation helpers shared by the tables and the compose form. */

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  return sameDay ? timeFormatter.format(date) : dateFormatter.format(date);
}

export function formatFullDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/** "in 3 min" / "2 h ago" — used for the scheduled column's tooltip line. */
export function formatRelative(iso: string | null): string {
  if (!iso) return '';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '';

  const diffMs = target - Date.now();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  const [value, unit] =
    abs < hour
      ? [Math.round(abs / minute), 'min']
      : abs < day
        ? [Math.round(abs / hour), 'h']
        : [Math.round(abs / day), 'd'];

  if (value === 0) return 'now';
  return diffMs > 0 ? `in ${value} ${unit}` : `${value} ${unit} ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/**
 * Value for a `datetime-local` input, in the browser's timezone.
 * `toISOString()` would silently shift the user's chosen time to UTC.
 */
export function toLocalInputValue(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}
