import clsx from 'clsx';

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} aria-hidden />;
}

/** Row placeholders that mirror the real table layout, so nothing jumps. */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading emails" className="divide-y divide-line">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-5 py-3.5">
          <Skeleton className="h-4 w-40 shrink-0" />
          <Skeleton className="h-4 w-14 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}
