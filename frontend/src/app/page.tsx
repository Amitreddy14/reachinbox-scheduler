'use client';

import { useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { GoogleSignInButton } from '@/components/GoogleSignInButton';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';

/**
 * Login screen. Google is the only identity provider, so there is no form to
 * validate — the screen is one real OAuth action plus the states around it.
 */
export default function LoginPage() {
  const router = useRouter();
  const toast = useToast();
  const { state, user, signInWithGoogle } = useAuth();

  useEffect(() => {
    if (state === 'ready' && user) router.replace('/dashboard');
  }, [state, user, router]);

  const handleCredential = useCallback(
    async (credential: string) => {
      try {
        await signInWithGoogle(credential);
        router.replace('/dashboard');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Sign-in failed');
      }
    },
    [signInWithGoogle, router, toast],
  );

  if (state === 'ready' && user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-muted">
        <Loader2 className="h-5 w-5 animate-spin text-ink-subtle" aria-label="Loading" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface-muted px-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-white p-8 shadow-card">
        <div className="flex flex-col items-center gap-1 text-center">
          <Logo />
          <h1 className="mt-5 text-xl font-semibold text-ink">Login</h1>
          <p className="text-sm text-ink-subtle">
            Sign in to schedule and track your outreach sends.
          </p>
        </div>

        <div className="mt-7 flex justify-center">
          <GoogleSignInButton onCredential={handleCredential} disabled={state === 'loading'} />
        </div>

        <p className="mt-6 text-center text-xs leading-relaxed text-ink-faint">
          We only read your name, email address and profile picture.
        </p>
      </div>

      <p className="mt-6 text-xs text-ink-faint">
        Email job scheduler · BullMQ · Redis · Elasticsearch
      </p>
    </main>
  );
}
