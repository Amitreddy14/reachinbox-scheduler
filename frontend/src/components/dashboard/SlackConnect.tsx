'use client';

import { useState } from 'react';
import { Bell, BellOff, Slack } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import type { SlackStatus } from '@/types';

export interface SlackConnectProps {
  slack?: SlackStatus;
  onChange: () => void;
}

/**
 * Rate-limit alerts go to whichever workspace the user connects here. The OAuth
 * redirect leaves the SPA entirely, so the backend pins the session to a
 * short-lived `state` value and sends the browser back to /dashboard.
 */
export function SlackConnect({ slack, onChange }: SlackConnectProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!slack) return null;

  const connected = slack.integration.connected;

  const handleConnect = async () => {
    setBusy(true);
    try {
      const { url } = await api.slackInstallUrl();
      window.location.href = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the Slack install');
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      await api.slackDisconnect();
      toast.info('Slack disconnected. Rate-limit alerts will stop.');
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect Slack');
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setBusy(true);
    try {
      const result = await api.slackTest();
      if (result.delivered) toast.success(result.message);
      else toast.info(result.message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the test alert');
    } finally {
      setBusy(false);
    }
  };

  if (!slack.configured) {
    return (
      <span className="hidden text-2xs text-ink-faint lg:inline">
        Slack alerts off — set SLACK_CLIENT_ID on the server
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {connected ? (
        <>
          <span className="hidden items-center gap-1.5 rounded-pill bg-brand-50 px-2.5 py-1 text-2xs font-medium text-brand-700 sm:inline-flex">
            <Bell className="h-3 w-3" aria-hidden />
            {slack.integration.teamName}
            {slack.integration.channelName && ` · ${slack.integration.channelName}`}
          </span>
          <Button size="sm" variant="ghost" onClick={handleTest} loading={busy}>
            Test alert
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDisconnect}
            disabled={busy}
            leftIcon={<BellOff className="h-3.5 w-3.5" />}
          >
            Disconnect
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={handleConnect}
          loading={busy}
          leftIcon={<Slack className="h-3.5 w-3.5" />}
        >
          Connect Slack
        </Button>
      )}
    </div>
  );
}
