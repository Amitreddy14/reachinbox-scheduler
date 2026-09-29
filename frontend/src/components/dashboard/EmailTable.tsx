'use client';

import { AlertTriangle, ExternalLink, Inbox, SendHorizonal, X } from 'lucide-react';
import clsx from 'clsx';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { TableSkeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { formatDateTime, formatFullDateTime, formatRelative, truncate } from '@/lib/format';
import type { EmailListItem } from '@/types';
import type { Tab } from '@/hooks/useEmails';

export interface EmailTableProps {
  tab: Tab;
  items: EmailListItem[];
  total: number;
  page: number;
  pageSize: number;
  isLoading: boolean;
  error?: Error;
  query: string;
  onPageChange: (page: number) => void;
  onCompose: () => void;
  onCancel: (emailId: string) => void;
  cancellingId: string | null;
}

export function EmailTable({
  tab,
  items,
  total,
  page,
  pageSize,
  isLoading,
  error,
  query,
  onPageChange,
  onCompose,
  onCancel,
  cancellingId,
}: EmailTableProps) {
  if (isLoading) return <TableSkeleton rows={8} />;

  if (error) {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-5 w-5 text-danger-500" />}
        title="Could not load emails"
        description={error.message}
      />
    );
  }

  if (items.length === 0) {
    return query ? (
      <EmptyState
        icon={<Inbox className="h-5 w-5" />}
        title="No matches"
        description={`Nothing in ${tab} emails matches “${truncate(query, 40)}”.`}
      />
    ) : tab === 'scheduled' ? (
      <EmptyState
        icon={<Inbox className="h-5 w-5" />}
        title="Nothing scheduled yet"
        description="Compose a campaign, upload a lead list and pick a start time. Everything queued will appear here."
        action={
          <Button size="sm" variant="outline" onClick={onCompose}>
            Compose new email
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<SendHorizonal className="h-5 w-5" />}
        title="No emails sent yet"
        description="Once the worker starts delivering, every send lands here with its Ethereal preview link."
      />
    );
  }

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex h-full flex-col">
      <ul className="flex-1 divide-y divide-line overflow-y-auto">
        {items.map((item) => (
          <EmailRow
            key={item.id}
            item={item}
            tab={tab}
            onCancel={onCancel}
            cancelling={cancellingId === item.id}
          />
        ))}
      </ul>

      <div className="flex shrink-0 items-center justify-between border-t border-line px-5 py-2.5 text-xs text-ink-subtle">
        <span className="tabular-nums">
          {start.toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()}
        </span>

        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </Button>
          <span className="px-2 tabular-nums">
            {page} / {totalPages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

interface EmailRowProps {
  item: EmailListItem;
  tab: Tab;
  onCancel: (emailId: string) => void;
  cancelling: boolean;
}

function EmailRow({ item, tab, onCancel, cancelling }: EmailRowProps) {
  const timestamp = tab === 'sent' ? item.sentAt : item.scheduledAt;
  const canCancel = item.status === 'SCHEDULED' || item.status === 'QUEUED';

  return (
    <li className="group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-surface-muted">
      <div className="w-52 shrink-0 truncate text-sm text-ink" title={item.toEmail}>
        <span className="text-ink-subtle">To:</span> {item.toEmail}
      </div>

      <div className="w-20 shrink-0">
        <StatusBadge status={item.status} />
      </div>

      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 truncate text-sm font-medium text-ink">{item.subject}</span>
        {item.status === 'FAILED' && item.lastError && (
          <span className="truncate text-xs text-danger-500" title={item.lastError}>
            — {item.lastError}
          </span>
        )}
        {item.deferCount > 0 && item.status !== 'FAILED' && (
          <span
            className="shrink-0 text-2xs text-warn-500"
            title={`Pushed into a later window ${item.deferCount} time(s) by the rate limiter`}
          >
            rescheduled ×{item.deferCount}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {item.previewUrl && (
          <a
            href={item.previewUrl}
            target="_blank"
            rel="noreferrer"
            title="Open the Ethereal preview"
            className="rounded p-1 text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 focus:opacity-100"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">Open preview for {item.toEmail}</span>
          </a>
        )}

        {canCancel && (
          <button
            type="button"
            onClick={() => onCancel(item.id)}
            disabled={cancelling}
            title="Cancel this send"
            className={clsx(
              'rounded p-1 text-ink-faint transition-opacity hover:text-danger-500',
              cancelling ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
            )}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">Cancel email to {item.toEmail}</span>
          </button>
        )}

        <time
          dateTime={timestamp ?? undefined}
          title={`${formatFullDateTime(timestamp)} · from ${item.senderEmail}`}
          className="w-24 text-right text-xs tabular-nums text-ink-subtle"
        >
          {formatDateTime(timestamp)}
          {tab === 'scheduled' && (
            <span className="block text-2xs text-ink-faint">{formatRelative(timestamp)}</span>
          )}
        </time>
      </div>
    </li>
  );
}
