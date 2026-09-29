'use client';

import useSWR from 'swr';
import { api } from '@/lib/api';
import type { EmailListResponse, Sender, ServerConfig, SlackStatus, StatsResponse } from '@/types';

export type Tab = 'scheduled' | 'sent';

export interface UseEmailsOptions {
  tab: Tab;
  query: string;
  page: number;
  pageSize?: number;
  enabled: boolean;
}

/**
 * SWR keys are plain tuples rather than URLs because the request needs the
 * bearer token, which the shared fetcher would not add for a raw string key.
 */
export function useEmails({ tab, query, page, pageSize = 25, enabled }: UseEmailsOptions) {
  const { data, error, isLoading, isValidating, mutate } = useSWR<EmailListResponse>(
    enabled ? (['emails', tab, query, page, pageSize] as const) : null,
    () => api.listEmails({ tab, q: query || undefined, page, pageSize }),
  );

  return {
    data,
    // `isLoading` is only true on the first fetch; a background poll must not
    // replace the table with skeletons.
    isLoading,
    isRefreshing: isValidating && !isLoading,
    error: error as Error | undefined,
    refresh: mutate,
  };
}

export function useStats(enabled: boolean) {
  const { data, mutate } = useSWR<StatsResponse>(
    enabled ? (['stats'] as const) : null,
    () => api.stats(),
  );
  return { stats: data, refresh: mutate };
}

export function useSenders(enabled: boolean) {
  const { data, mutate } = useSWR<{ senders: Sender[] }>(
    enabled ? (['senders'] as const) : null,
    () => api.senders(),
    { refreshInterval: 15_000 },
  );
  return { senders: data?.senders ?? [], refresh: mutate };
}

export function useServerConfig(enabled: boolean) {
  const { data } = useSWR<ServerConfig>(
    enabled ? (['config'] as const) : null,
    () => api.config(),
    { refreshInterval: 0, revalidateOnFocus: false },
  );
  return data;
}

export function useSlackStatus(enabled: boolean) {
  const { data, mutate } = useSWR<SlackStatus>(
    enabled ? (['slack'] as const) : null,
    () => api.slackStatus(),
    { refreshInterval: 0 },
  );
  return { slack: data, refresh: mutate };
}
