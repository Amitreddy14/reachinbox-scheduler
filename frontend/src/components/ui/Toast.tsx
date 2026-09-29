'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import clsx from 'clsx';

type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  notify: (tone: ToastTone, message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONES: Record<ToastTone, { icon: ReactNode; className: string }> = {
  success: {
    icon: <CheckCircle2 className="h-4 w-4 text-brand-500" />,
    className: 'border-brand-200',
  },
  error: {
    icon: <AlertCircle className="h-4 w-4 text-danger-500" />,
    className: 'border-danger-500/40',
  },
  info: { icon: <Info className="h-4 w-4 text-ink-muted" />, className: 'border-line' },
};

const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  // The toast layer is a portal into document.body, which does not exist during
  // server rendering. Rendering it only after mount keeps the first client pass
  // identical to the server's HTML, which is what React checks at hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (tone: ToastTone, message: string) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current, { id, tone, message }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      notify,
      success: (message: string) => notify('success', message),
      error: (message: string) => notify('error', message),
      info: (message: string) => notify('info', message),
    }),
    [notify],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {mounted &&
        createPortal(
          <div
            // Polite so a success message never interrupts what the user is typing.
            aria-live="polite"
            className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-full max-w-sm flex-col gap-2"
          >
            {toasts.map((toast) => (
              <div
                key={toast.id}
                className={clsx(
                  'pointer-events-auto flex animate-scale-in items-start gap-2.5 rounded-lg border bg-white px-3.5 py-3 shadow-card',
                  TONES[toast.tone].className,
                )}
              >
                <span className="mt-0.5 shrink-0">{TONES[toast.tone].icon}</span>
                <p className="flex-1 text-sm text-ink">{toast.message}</p>
                <button
                  type="button"
                  onClick={() => dismiss(toast.id)}
                  aria-label="Dismiss notification"
                  className="-mr-1 -mt-0.5 rounded p-1 text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider');
  return context;
}
