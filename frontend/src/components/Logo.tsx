import clsx from 'clsx';

/**
 * Wordmark from the Figma: a flat, letter-spaced monogram rather than an image,
 * so it stays crisp at any size and needs no asset pipeline.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        'select-none text-lg font-extrabold tracking-[0.22em] text-ink',
        className,
      )}
    >
      ONB
    </span>
  );
}
