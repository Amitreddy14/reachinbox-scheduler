'use client';

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, FileUp, Loader2, Paperclip, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { parseLeads, readFileAsText, type ParsedLeads } from '@/lib/leads';
import { formatDuration, pluralise, toLocalInputValue } from '@/lib/format';
import type { Sender, ServerConfig } from '@/types';

export interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  onScheduled: () => void;
  senders: Sender[];
  config?: ServerConfig;
}

interface FormErrors {
  subject?: string;
  body?: string;
  recipients?: string;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function ComposeModal({
  open,
  onClose,
  onScheduled,
  senders,
  config,
}: ComposeModalProps) {
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [leads, setLeads] = useState<ParsedLeads | null>(null);
  const [manualRecipients, setManualRecipients] = useState('');
  const [startAt, setStartAt] = useState(() => toLocalInputValue(new Date(Date.now() + 60_000)));
  const [delaySeconds, setDelaySeconds] = useState(2);
  const [hourlyLimit, setHourlyLimit] = useState(200);
  const [senderId, setSenderId] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [parsing, setParsing] = useState(false);

  /** File list and the manual box are merged and de-duplicated together. */
  const recipients = useMemo(() => {
    const fromFile = leads?.emails ?? [];
    const fromBox = manualRecipients.trim() ? parseLeads(manualRecipients).emails : [];
    return [...new Set([...fromFile, ...fromBox])];
  }, [leads, manualRecipients]);

  const maxHourly = config?.maxEmailsPerHourPerSender ?? 200;
  const activeSenderCount = senderId ? 1 : Math.max(1, senders.filter((s) => s.isActive).length);
  const estimatedHours = Math.ceil(recipients.length / Math.max(1, hourlyLimit * activeSenderCount));

  const reset = () => {
    setSubject('');
    setBody('');
    setFileName(null);
    setLeads(null);
    setManualRecipients('');
    setStartAt(toLocalInputValue(new Date(Date.now() + 60_000)));
    setDelaySeconds(2);
    setHourlyLimit(200);
    setSenderId('');
    setErrors({});
  };

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;

    if (file.size > MAX_FILE_BYTES) {
      toast.error('That file is larger than 5 MB. Split the list and try again.');
      return;
    }

    setParsing(true);
    try {
      const text = await readFileAsText(file);
      const parsed = parseLeads(text);

      if (parsed.emails.length === 0) {
        toast.error('No email addresses were found in that file.');
        setLeads(null);
        setFileName(null);
        return;
      }

      setLeads(parsed);
      setFileName(file.name);
      setErrors((current) => ({ ...current, recipients: undefined }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read that file');
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const validate = (): boolean => {
    const next: FormErrors = {};
    if (!subject.trim()) next.subject = 'Subject is required';
    if (!body.trim()) next.body = 'Body is required';
    if (recipients.length === 0) next.recipients = 'Upload a lead list or paste at least one address';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) return;

    setSubmitting(true);
    try {
      const result = await api.schedule({
        subject: subject.trim(),
        body,
        recipients,
        startAt: new Date(startAt).toISOString(),
        delayMs: Math.round(delaySeconds * 1000),
        hourlyLimit,
        ...(senderId ? { senderIds: [senderId] } : {}),
      });

      toast.success(
        `${pluralise(result.campaign.totalRecipients, 'email')} scheduled from ${pluralise(
          result.campaign.senders.length,
          'sender',
        )}.`,
      );
      reset();
      onScheduled();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not schedule this campaign');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Compose New Email"
      description="Upload a lead list, choose when sending starts and how fast it goes out."
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="compose-form"
            loading={submitting}
            disabled={recipients.length === 0}
          >
            Schedule {recipients.length > 0 && `(${recipients.length.toLocaleString()})`}
          </Button>
        </>
      }
    >
      <form id="compose-form" onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="From"
            value={senderId}
            onChange={(event) => setSenderId(event.target.value)}
            hint={
              senderId
                ? 'This campaign uses one mailbox.'
                : 'Recipients are spread across every active mailbox.'
            }
          >
            <option value="">All senders (round-robin)</option>
            {senders
              .filter((sender) => sender.isActive)
              .map((sender) => (
                <option key={sender.id} value={sender.id}>
                  {sender.email} · {sender.usedThisHour}/{sender.hourlyLimit} this hour
                </option>
              ))}
          </Select>

          <Input
            label="Start time"
            type="datetime-local"
            value={startAt}
            onChange={(event) => setStartAt(event.target.value)}
            hint="A time in the past starts sending immediately."
          />
        </div>

        <Input
          label="Subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="Quick question about your outbound stack"
          error={errors.subject}
          maxLength={300}
        />

        <Textarea
          label="Body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={'Hi there,\n\nI noticed…'}
          rows={7}
          error={errors.body}
          hint="Plain text or HTML — a text part is generated automatically."
        />

        {/* -------- lead list -------- */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-ink-muted">Lead list</p>

          <div className="rounded-lg border border-dashed border-line-strong bg-surface-muted p-4">
            {leads && fileName ? (
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-brand-500" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{fileName}</p>
                  <p className="text-xs text-ink-subtle">
                    {pluralise(leads.emails.length, 'address')} detected
                    {leads.duplicates > 0 && ` · ${leads.duplicates} duplicate removed`}
                    {leads.skippedLines > 0 && ` · ${leads.skippedLines} line skipped`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setLeads(null);
                    setFileName(null);
                  }}
                  aria-label="Remove the uploaded list"
                  className="rounded p-1 text-ink-faint transition-colors hover:bg-white hover:text-ink"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-2 text-center">
                {parsing ? (
                  <Loader2 className="h-5 w-5 animate-spin text-ink-subtle" aria-hidden />
                ) : (
                  <FileUp className="h-5 w-5 text-ink-faint" aria-hidden />
                )}
                <p className="text-sm text-ink-muted">
                  Upload a CSV or text file of leads
                </p>
                <p className="text-xs text-ink-faint">
                  Any column layout works — every address in the file is picked up.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  leftIcon={<Paperclip className="h-3.5 w-3.5" />}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={parsing}
                >
                  Upload List
                </Button>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="sr-only"
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
          </div>

          <Textarea
            value={manualRecipients}
            onChange={(event) => setManualRecipients(event.target.value)}
            placeholder="…or paste addresses here, separated by commas or new lines"
            rows={2}
            error={errors.recipients}
          />
        </div>

        {/* -------- throttling -------- */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Delay between emails"
            type="number"
            min={0}
            step={0.5}
            value={delaySeconds}
            onChange={(event) => setDelaySeconds(Number(event.target.value))}
            hint={`Server floor: ${formatDuration(config?.minGapMsPerSender ?? 2000)} per sender.`}
          />

          <Input
            label="Hourly limit per sender"
            type="number"
            min={1}
            max={maxHourly}
            value={hourlyLimit}
            onChange={(event) => setHourlyLimit(Number(event.target.value))}
            hint={`Server ceiling: ${maxHourly.toLocaleString()} per sender per hour.`}
          />
        </div>

        {recipients.length > 0 && (
          <p className="rounded-lg bg-brand-50 px-3 py-2.5 text-xs text-brand-700">
            {pluralise(recipients.length, 'email')} across{' '}
            {pluralise(activeSenderCount, 'sender')} — roughly{' '}
            {estimatedHours <= 1 ? 'under an hour' : `${estimatedHours} hours`} to deliver at these
            limits. Anything over the cap is pushed into the next hour window, never dropped.
          </p>
        )}
      </form>
    </Modal>
  );
}
