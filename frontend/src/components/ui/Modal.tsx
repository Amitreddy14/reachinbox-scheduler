'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import clsx from 'clsx';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg' | 'xl';
}

const SIZES = { md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const;

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'lg',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Callers pass an inline arrow for onClose, so its identity changes on every
  // render of the parent. Keeping it in a ref lets the effects below depend on
  // `open` alone — otherwise they would tear down and re-run on every keystroke
  // inside the dialog, and the focus() call would yank the caret out of the
  // field the user is typing in.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Escape closes, and the page behind does not scroll while the dialog is up.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Move focus into the dialog once, as it opens, so the keyboard lands
  // somewhere sensible. Never on a re-render.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6">
      <div
        className="fixed inset-0 animate-fade-in bg-ink/30 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={clsx(
          'relative z-10 my-4 w-full animate-scale-in rounded-xl bg-white shadow-overlay focus:outline-none',
          SIZES[size],
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-ink-subtle">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="-mr-1 rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
