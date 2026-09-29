import clsx from 'clsx';
import type { EmailStatus } from '@/types';

const STYLES: Record<EmailStatus, { label: string; className: string }> = {
  SCHEDULED: { label: 'Scheduled', className: 'bg-surface-sunken text-ink-muted' },
  QUEUED: { label: 'Queued', className: 'bg-surface-sunken text-ink-muted' },
  SENDING: { label: 'Sending', className: 'bg-warn-50 text-warn-500' },
  SENT: { label: 'Sent', className: 'bg-brand-50 text-brand-700' },
  FAILED: { label: 'Failed', className: 'bg-danger-50 text-danger-500' },
  CANCELLED: { label: 'Cancelled', className: 'bg-surface-sunken text-ink-subtle line-through' },
};

export function StatusBadge({ status, className }: { status: EmailStatus; className?: string }) {
  const style = STYLES[status];
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide',
        style.className,
        className,
      )}
    >
      {style.label}
    </span>
  );
}
