'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, PenSquare } from 'lucide-react';
import clsx from 'clsx';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { Header } from '@/components/dashboard/Header';
import { EmailTable } from '@/components/dashboard/EmailTable';
import { ComposeModal } from '@/components/dashboard/ComposeModal';
import { SlackConnect } from '@/components/dashboard/SlackConnect';
import { QueueBar } from '@/components/dashboard/QueueBar';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import {
  useEmails,
  useSenders,
  useServerConfig,
  useSlackStatus,
  useStats,
  type Tab,
} from '@/hooks/useEmails';
import { useDebounced } from '@/hooks/useDebounced';
import { api } from '@/lib/api';

const TABS: { id: Tab; label: string }[] = [
  { id: 'scheduled', label: 'Scheduled Emails' },
  { id: 'sent', label: 'Sent Emails' },
];

export default function DashboardPage() {
  const router = useRouter();
  const toast = useToast();

  const { state, user, error: sessionError } = useAuth();
  const ready = state === 'ready' && user !== null;

  const [tab, setTab] = useState<Tab>('scheduled');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  // Typing in the search box should not fire a request per keystroke.
  const debouncedQuery = useDebounced(query, 300);

  const { data, isLoading, isRefreshing, error, refresh } = useEmails({
    tab,
    query: debouncedQuery,
    page,
    enabled: ready,
  });
  const { stats, refresh: refreshStats } = useStats(ready);
  const { senders, refresh: refreshSenders } = useSenders(ready);
  const { slack, refresh: refreshSlack } = useSlackStatus(ready);
  const config = useServerConfig(ready);

  useEffect(() => {
    if (state === 'unauthenticated') router.replace('/');
  }, [state, router]);

  // A new search or a tab switch always restarts at page one.
  useEffect(() => {
    setPage(1);
  }, [tab, debouncedQuery]);

  // Slack bounces the browser back with ?slack=connected|error:<reason>.
  // Read straight from the URL rather than useSearchParams, which would force
  // this whole page behind a Suspense boundary just to read one flag.
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('slack');
    if (!result) return;

    if (result === 'connected') {
      toast.success('Slack connected. Rate-limit alerts will post to your workspace.');
      void refreshSlack();
    } else if (result.startsWith('error:')) {
      toast.error(`Slack connection failed: ${result.slice(6)}`);
    }
    router.replace('/dashboard');
  }, [router, toast, refreshSlack]);

  const refreshAll = useCallback(() => {
    void refresh();
    void refreshStats();
    void refreshSenders();
  }, [refresh, refreshStats, refreshSenders]);

  const handleCancel = async (emailId: string) => {
    setCancellingId(emailId);
    try {
      await api.cancelEmail(emailId);
      toast.info('Email cancelled.');
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel that email');
    } finally {
      setCancellingId(null);
    }
  };

  if (state === 'loading' || state === 'unauthenticated') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-muted">
        <Loader2 className="h-5 w-5 animate-spin text-ink-subtle" aria-label="Loading" />
      </main>
    );
  }

  if (state === 'error' || !user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-surface-muted px-4 text-center">
        <AlertTriangle className="h-6 w-6 text-danger-500" aria-hidden />
        <h1 className="text-base font-semibold text-ink">Could not reach the scheduler API</h1>
        <p className="max-w-md text-sm text-ink-subtle">
          {sessionError ?? 'The backend did not respond.'} Check that the Express service is
          running and that NEXT_PUBLIC_API_URL points at it.
        </p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </main>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-surface-muted">
      <Sidebar
        user={user}
        activeTab={tab}
        onTabChange={setTab}
        scheduledCount={stats?.counts.scheduledTotal ?? 0}
        sentCount={stats?.counts.sentTotal ?? 0}
        onCompose={() => setComposeOpen(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          user={user}
          query={query}
          onQueryChange={setQuery}
          onRefresh={refreshAll}
          isRefreshing={isRefreshing}
          queueDashboardUrl={config?.queueDashboardUrl}
          searchEngine={data?.engine}
        />

        <div className="flex shrink-0 items-center gap-1 border-b border-line bg-white px-5">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-current={tab === item.id ? 'page' : undefined}
              className={clsx(
                '-mb-px border-b-2 px-3 py-3 text-sm transition-colors',
                tab === item.id
                  ? 'border-brand-500 font-medium text-ink'
                  : 'border-transparent text-ink-subtle hover:text-ink',
              )}
            >
              {item.label}
              {tab === item.id && data && (
                <span className="ml-2 text-2xs tabular-nums text-ink-faint">
                  {data.total.toLocaleString()}
                </span>
              )}
            </button>
          ))}

          <div className="ml-auto flex items-center gap-2 py-2">
            <SlackConnect slack={slack} onChange={() => void refreshSlack()} />
            <Button
              size="sm"
              leftIcon={<PenSquare className="h-3.5 w-3.5" />}
              onClick={() => setComposeOpen(true)}
            >
              Compose New Email
            </Button>
          </div>
        </div>

        <QueueBar stats={stats} senders={senders} config={config} />

        <main className="min-h-0 flex-1 overflow-hidden bg-white">
          <EmailTable
            tab={tab}
            items={data?.items ?? []}
            total={data?.total ?? 0}
            page={page}
            pageSize={data?.pageSize ?? 25}
            isLoading={isLoading}
            error={error}
            query={debouncedQuery}
            onPageChange={setPage}
            onCompose={() => setComposeOpen(true)}
            onCancel={handleCancel}
            cancellingId={cancellingId}
          />
        </main>
      </div>

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onScheduled={refreshAll}
        senders={senders}
        config={config}
      />
    </div>
  );
}
