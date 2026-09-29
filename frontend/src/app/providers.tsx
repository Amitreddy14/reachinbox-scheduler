'use client';

import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { fetcher } from '@/lib/api';
import { ToastProvider } from '@/components/ui/Toast';
import { AuthProvider } from '@/hooks/useAuth';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher,
        revalidateOnFocus: true,
        // The tables poll so a send completed by the worker shows up without
        // the user reaching for refresh.
        refreshInterval: 5000,
        shouldRetryOnError: false,
        keepPreviousData: true,
      }}
    >
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </SWRConfig>
  );
}
