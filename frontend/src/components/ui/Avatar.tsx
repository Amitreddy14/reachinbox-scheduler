'use client';

import { useState } from 'react';
import clsx from 'clsx';

export interface AvatarProps {
  src?: string | null;
  name: string;
  size?: 'sm' | 'md';
  className?: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}

const SIZES = { sm: 'h-7 w-7 text-2xs', md: 'h-9 w-9 text-xs' } as const;

/**
 * Falls back to initials when the Google avatar 404s or the account has none,
 * so the header never shows a broken image icon.
 */
export function Avatar({ src, name, size = 'md', className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const classes = clsx(
    'shrink-0 overflow-hidden rounded-full object-cover',
    SIZES[size],
    className,
  );

  if (src && !failed) {
    // A plain <img>: avatars come from Google's CDN and already fall back to
    // initials on error, so the Next image optimizer buys nothing here.
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={classes}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={clsx(
        classes,
        'flex items-center justify-center bg-brand-100 font-semibold text-brand-700',
      )}
    >
      {initials(name)}
    </span>
  );
}
