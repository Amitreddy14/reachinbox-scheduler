'use client';

import clsx from 'clsx';
import { Clock, PenSquare, Send } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { Avatar } from '@/components/ui/Avatar';
import type { AppUser } from '@/types';
import type { Tab } from '@/hooks/useEmails';

export interface SidebarProps {
  user: AppUser;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  scheduledCount: number;
  sentCount: number;
  onCompose: () => void;
}

interface NavItem {
  tab: Tab;
  label: string;
  icon: typeof Clock;
  count: number;
}

export function Sidebar({
  user,
  activeTab,
  onTabChange,
  scheduledCount,
  sentCount,
  onCompose,
}: SidebarProps) {
  const items: NavItem[] = [
    { tab: 'scheduled', label: 'Scheduled', icon: Clock, count: scheduledCount },
    { tab: 'sent', label: 'Sent', icon: Send, count: sentCount },
  ];

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-white">
      <div className="px-5 py-5">
        <Logo />
      </div>

      <div className="px-3">
        <div className="flex items-center gap-2.5 rounded-lg border border-line px-2.5 py-2">
          <Avatar src={user.avatarUrl} name={user.name} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-ink">{user.name}</p>
            <p className="truncate text-2xs text-ink-subtle">{user.email}</p>
          </div>
        </div>
      </div>

      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={onCompose}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-brand-500 text-sm font-medium text-brand-600 transition-colors hover:bg-brand-50 active:bg-brand-100"
        >
          <PenSquare className="h-4 w-4" aria-hidden />
          Compose
        </button>
      </div>

      <nav className="mt-5 flex-1 px-3" aria-label="Email folders">
        <p className="px-2 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
          Core
        </p>

        <ul className="space-y-0.5">
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.tab;

            return (
              <li key={item.tab}>
                <button
                  type="button"
                  onClick={() => onTabChange(item.tab)}
                  aria-current={isActive ? 'page' : undefined}
                  className={clsx(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-brand-50 font-medium text-brand-700'
                      : 'text-ink-muted hover:bg-surface-muted',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="flex-1 text-left">{item.label}</span>
                  {item.count > 0 && (
                    <span
                      className={clsx(
                        'text-2xs tabular-nums',
                        isActive ? 'text-brand-600' : 'text-ink-faint',
                      )}
                    >
                      {item.count.toLocaleString()}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
