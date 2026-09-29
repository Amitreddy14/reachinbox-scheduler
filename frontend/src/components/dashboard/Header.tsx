'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, LogOut, RefreshCw, Search } from 'lucide-react';
import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { Avatar } from '@/components/ui/Avatar';
import { useAuth } from '@/hooks/useAuth';
import type { AppUser } from '@/types';

export interface HeaderProps {
  user: AppUser;
  query: string;
  onQueryChange: (value: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  queueDashboardUrl?: string;
  searchEngine?: 'elasticsearch' | 'postgres';
}

export function Header({
  user,
  query,
  onQueryChange,
  onRefresh,
  isRefreshing,
  queueDashboardUrl,
  searchEngine,
}: HeaderProps) {
  const router = useRouter();
  const { signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Click-outside and Escape both close the account menu.
  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const handleLogout = () => {
    setMenuOpen(false);
    signOut();
    router.replace('/');
  };

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-white px-5">
      <div className="relative max-w-xl flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search by recipient, subject or body"
          aria-label="Search emails"
          className="h-10 w-full rounded-pill border border-transparent bg-surface-sunken pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint transition-colors focus:border-line-strong focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/15"
        />
      </div>

      {searchEngine === 'postgres' && (
        <span
          title="Elasticsearch is unreachable — results are coming from Postgres"
          className="hidden rounded px-2 py-1 text-2xs font-medium text-warn-500 ring-1 ring-inset ring-warn-500/25 sm:inline"
        >
          DB fallback
        </span>
      )}

      <button
        type="button"
        onClick={onRefresh}
        aria-label="Refresh list"
        className="rounded-lg p-2 text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
      >
        <RefreshCw className={clsx('h-4 w-4', isRefreshing && 'animate-spin')} aria-hidden />
      </button>

      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 transition-colors hover:bg-surface-muted"
        >
          <Avatar src={user.avatarUrl} name={user.name} />
          <span className="hidden text-left sm:block">
            <span className="block text-xs font-medium leading-tight text-ink">{user.name}</span>
            <span className="block text-2xs leading-tight text-ink-subtle">{user.email}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-20 mt-1.5 w-60 animate-scale-in rounded-lg border border-line bg-white py-1 shadow-overlay"
          >
            <div className="border-b border-line px-3 py-2.5">
              <p className="truncate text-sm font-medium text-ink">{user.name}</p>
              <p className="truncate text-xs text-ink-subtle">{user.email}</p>
            </div>

            {queueDashboardUrl && (
              <a
                href={queueDashboardUrl}
                target="_blank"
                rel="noreferrer"
                role="menuitem"
                className="flex items-center gap-2 px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-muted"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                Queue dashboard
              </a>
            )}

            <button
              type="button"
              role="menuitem"
              onClick={handleLogout}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-muted"
            >
              <LogOut className="h-4 w-4" aria-hidden />
              Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
