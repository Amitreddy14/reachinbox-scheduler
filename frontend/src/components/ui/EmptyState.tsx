import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-sunken text-ink-subtle">
        {icon}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mx-auto max-w-sm text-sm text-ink-subtle">{description}</p>
      </div>
      {action}
    </div>
  );
}
