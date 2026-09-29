'use client';

import { Activity, Clock3, Gauge, Layers } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Sender, ServerConfig, StatsResponse } from '@/types';
import { formatDuration } from '@/lib/format';

export interface QueueBarProps {
  stats?: StatsResponse;
  senders: Sender[];
  config?: ServerConfig;
}

/**
 * A single row of live numbers under the tab strip. It exists so the throttling
 * behaviour is visible while a demo is running: delayed jobs climb when the
 * limiter defers, and each sender's hour usage fills up in real time.
 */
export function QueueBar({ stats, senders, config }: QueueBarProps) {
  if (!stats) return null;

  const { queue } = stats;
  const nearLimit = senders.filter(
    (sender) => sender.hourlyLimit > 0 && sender.usedThisHour / sender.hourlyLimit >= 0.8,
  );

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-white px-5 py-2 text-xs text-ink-subtle">
      <Metric icon={<Layers className="h-3.5 w-3.5" />} label="Delayed" value={queue.delayed} />
      <Metric icon={<Activity className="h-3.5 w-3.5" />} label="Active" value={queue.active} />
      <Metric icon={<Clock3 className="h-3.5 w-3.5" />} label="Waiting" value={queue.waiting} />
      <Metric icon={<Gauge className="h-3.5 w-3.5" />} label="Failed" value={queue.failed} />

      {config && (
        <span className="hidden md:inline">
          concurrency {config.workerConcurrency} · min gap{' '}
          {formatDuration(config.minGapMsPerSender)}
        </span>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-3">
        {senders.map((sender) => {
          const ratio = sender.hourlyLimit > 0 ? sender.usedThisHour / sender.hourlyLimit : 0;
          return (
            <span
              key={sender.id}
              title={`${sender.email} — ${sender.usedThisHour} of ${sender.hourlyLimit} sent this hour`}
              className="flex items-center gap-1.5"
            >
              <span className="h-1.5 w-16 overflow-hidden rounded-pill bg-surface-sunken">
                <span
                  className={ratio >= 1 ? 'block h-full bg-danger-500' : 'block h-full bg-brand-500'}
                  style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
                />
              </span>
              <span className="tabular-nums">
                {sender.usedThisHour}/{sender.hourlyLimit}
              </span>
            </span>
          );
        })}

        {nearLimit.length > 0 && (
          <span className="text-warn-500">
            {nearLimit.length} sender{nearLimit.length > 1 ? 's' : ''} near the hourly cap
          </span>
        )}
      </div>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-ink-faint">{icon}</span>
      {label} <span className="font-medium tabular-nums text-ink">{value.toLocaleString()}</span>
    </span>
  );
}
