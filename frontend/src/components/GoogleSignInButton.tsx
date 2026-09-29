'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { GOOGLE_CLIENT_ID, loadGoogleIdentity } from '@/lib/googleIdentity';

export interface GoogleSignInButtonProps {
  onCredential: (credential: string) => void | Promise<void>;
  disabled?: boolean;
}

/**
 * Renders Google's own button. Using the official widget rather than a styled
 * link keeps the flow compliant with Google's branding rules and means the
 * consent screen, account chooser and error handling are Google's to own.
 */
export function GoogleSignInButton({ onCredential, disabled }: GoogleSignInButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onCredential);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  // Keep the latest callback without re-initialising GIS on every render.
  useEffect(() => {
    callbackRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) {
      setStatus('error');
      return;
    }

    let cancelled = false;

    void loadGoogleIdentity()
      .then((accounts) => {
        if (cancelled || !containerRef.current) return;

        accounts.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (response) => {
            void callbackRef.current(response.credential);
          },
          cancel_on_tap_outside: true,
          ux_mode: 'popup',
        });

        accounts.renderButton(containerRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width: 320,
        });

        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-danger-50 px-3 py-2.5 text-xs text-danger-500">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          {GOOGLE_CLIENT_ID
            ? 'Google sign-in could not load. Check your connection and reload.'
            : 'NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set — copy .env.local.example to .env.local.'}
        </span>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-[44px] items-center justify-center">
      {status === 'loading' && (
        <Loader2 className="absolute h-4 w-4 animate-spin text-ink-subtle" aria-label="Loading" />
      )}
      <div
        ref={containerRef}
        className={disabled ? 'pointer-events-none opacity-60' : undefined}
      />
    </div>
  );
}
