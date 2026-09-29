import { Client, errors as esErrors } from '@elastic/elasticsearch';
import { and, asc, count, desc, eq, gt, ilike, inArray, or, type SQL } from 'drizzle-orm';
import { env } from '../config/env';
import { childLogger } from '../config/logger';
import { db } from '../db/client';
import { emailJobs, senders, type EmailJob, type EmailStatusValue } from '../db/schema';

const log = childLogger('search');

export const client = new Client({
  node: env.ELASTICSEARCH_NODE,
  requestTimeout: 5000,
  maxRetries: 2,
});

let indexReady = false;
let lastHealthCheck = 0;

/**
 * Mapping notes:
 *  - `toEmail` is indexed twice: as a `keyword` for exact filters and as a
 *    `text` field with an edge-ngram-ish analyzer so "sar" finds
 *    "sarah@acme.io" while the user is still typing.
 *  - `subject`/`body` use the standard analyzer; that is what the free-text box
 *    actually searches.
 */
const INDEX_SETTINGS = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        email_prefix: { type: 'custom', tokenizer: 'email_tokenizer', filter: ['lowercase'] },
      },
      tokenizer: {
        email_tokenizer: { type: 'edge_ngram', min_gram: 2, max_gram: 20, token_chars: ['letter', 'digit'] },
      },
    },
  },
  mappings: {
    properties: {
      id: { type: 'keyword' },
      userId: { type: 'keyword' },
      campaignId: { type: 'keyword' },
      senderId: { type: 'keyword' },
      senderEmail: { type: 'keyword' },
      toEmail: {
        type: 'text',
        analyzer: 'email_prefix',
        search_analyzer: 'standard',
        fields: { raw: { type: 'keyword' } },
      },
      subject: { type: 'text', fields: { raw: { type: 'keyword' } } },
      bodyText: { type: 'text' },
      status: { type: 'keyword' },
      scheduledAt: { type: 'date' },
      sentAt: { type: 'date' },
      createdAt: { type: 'date' },
    },
  },
} as const;

export interface IndexedEmail {
  id: string;
  userId: string;
  campaignId: string;
  senderId: string;
  senderEmail: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  createdAt: string;
}

export function toDocument(job: EmailJob, senderEmail: string): IndexedEmail {
  return {
    id: job.id,
    userId: job.userId,
    campaignId: job.campaignId,
    senderId: job.senderId,
    senderEmail,
    toEmail: job.toEmail,
    subject: job.subject,
    bodyText: job.bodyText.slice(0, 8000),
    status: job.status,
    scheduledAt: job.scheduledAt.toISOString(),
    sentAt: job.sentAt ? job.sentAt.toISOString() : null,
    createdAt: job.createdAt.toISOString(),
  };
}

export async function ensureIndex(): Promise<boolean> {
  try {
    const exists = await client.indices.exists({ index: env.ELASTICSEARCH_INDEX });
    if (!exists) {
      await client.indices.create({ index: env.ELASTICSEARCH_INDEX, ...INDEX_SETTINGS });
      log.info({ index: env.ELASTICSEARCH_INDEX }, 'created Elasticsearch index');
    }
    indexReady = true;
    return true;
  } catch (err) {
    indexReady = false;
    log.warn({ err: (err as Error).message }, 'Elasticsearch unavailable at boot');
    return false;
  }
}

/** Cheap liveness probe, memoised for 15s so a dead ES does not slow the API. */
export async function isAvailable(): Promise<boolean> {
  const now = Date.now();
  if (indexReady && now - lastHealthCheck < 15_000) return true;
  try {
    await client.ping();
    lastHealthCheck = now;
    if (!indexReady) await ensureIndex();
    return indexReady;
  } catch {
    indexReady = false;
    return false;
  }
}

/**
 * Indexing is best effort by design: a search index that is momentarily stale
 * is acceptable, an email that fails to send because the index was down is not.
 */
export async function indexEmail(job: EmailJob, senderEmail: string): Promise<void> {
  try {
    await client.index({
      index: env.ELASTICSEARCH_INDEX,
      id: job.id,
      document: toDocument(job, senderEmail),
      refresh: false,
    });
  } catch (err) {
    log.debug({ err: (err as Error).message, id: job.id }, 'indexEmail failed (non-fatal)');
  }
}

export async function bulkIndex(jobs: EmailJob[], senderEmailById: Map<string, string>): Promise<void> {
  if (jobs.length === 0) return;
  const operations = jobs.flatMap((job) => [
    { index: { _index: env.ELASTICSEARCH_INDEX, _id: job.id } },
    toDocument(job, senderEmailById.get(job.senderId) ?? 'unknown'),
  ]);

  try {
    const res = await client.bulk({ refresh: false, operations });
    if (res.errors) {
      const firstError = res.items.find((item) => item.index?.error)?.index?.error;
      log.warn({ firstError }, 'bulk index reported item errors');
    }
  } catch (err) {
    log.debug({ err: (err as Error).message, count: jobs.length }, 'bulkIndex failed (non-fatal)');
  }
}

export async function removeFromIndex(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await client.bulk({
      refresh: false,
      operations: ids.map((id) => ({ delete: { _index: env.ELASTICSEARCH_INDEX, _id: id } })),
    });
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'removeFromIndex failed (non-fatal)');
  }
}

export interface SearchQuery {
  userId: string;
  q?: string;
  statuses?: string[];
  campaignId?: string;
  senderId?: string;
  from?: number;
  size?: number;
  sort?: 'scheduledAt' | 'sentAt' | 'createdAt';
  order?: 'asc' | 'desc';
}

export interface SearchOutcome {
  total: number;
  ids: string[];
  engine: 'elasticsearch' | 'postgres';
}

export async function searchEmails(query: SearchQuery): Promise<SearchOutcome> {
  const from = query.from ?? 0;
  const size = Math.min(query.size ?? 25, 100);

  if (await isAvailable()) {
    try {
      const filters: Record<string, unknown>[] = [{ term: { userId: query.userId } }];
      if (query.statuses?.length) filters.push({ terms: { status: query.statuses } });
      if (query.campaignId) filters.push({ term: { campaignId: query.campaignId } });
      if (query.senderId) filters.push({ term: { senderId: query.senderId } });

      const must = query.q
        ? [
            {
              multi_match: {
                query: query.q,
                fields: ['subject^3', 'toEmail^2', 'bodyText', 'senderEmail'],
                type: 'best_fields' as const,
                fuzziness: 'AUTO',
              },
            },
          ]
        : [{ match_all: {} }];

      const sortField = query.sort ?? 'scheduledAt';
      const res = await client.search<IndexedEmail>({
        index: env.ELASTICSEARCH_INDEX,
        from,
        size,
        track_total_hits: true,
        query: { bool: { must, filter: filters } },
        sort: [{ [sortField]: { order: query.order ?? 'desc', missing: '_last' } }],
      });

      const total =
        typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? 0);

      return { total, ids: res.hits.hits.map((hit) => hit._id as string), engine: 'elasticsearch' };
    } catch (err) {
      if (!(err instanceof esErrors.ResponseError)) indexReady = false;
      log.warn({ err: (err as Error).message }, 'Elasticsearch query failed');
      if (!env.ELASTICSEARCH_FALLBACK_TO_DB) throw err;
    }
  }

  if (!env.ELASTICSEARCH_FALLBACK_TO_DB) {
    throw new Error('Elasticsearch is unavailable and the Postgres fallback is disabled');
  }
  return searchViaPostgres(query, from, size);
}

/**
 * Fallback so a stopped Elasticsearch container degrades search quality instead
 * of taking the dashboard down. Deliberately simple: prefix/substring matching.
 */
async function searchViaPostgres(
  query: SearchQuery,
  from: number,
  size: number,
): Promise<SearchOutcome> {
  const conditions: SQL[] = [eq(emailJobs.userId, query.userId)];

  if (query.statuses?.length) {
    conditions.push(inArray(emailJobs.status, query.statuses as EmailStatusValue[]));
  }
  if (query.campaignId) conditions.push(eq(emailJobs.campaignId, query.campaignId));
  if (query.senderId) conditions.push(eq(emailJobs.senderId, query.senderId));
  if (query.q) {
    const term = `%${query.q}%`;
    const fuzzy = or(
      ilike(emailJobs.subject, term),
      ilike(emailJobs.toEmail, term),
      ilike(emailJobs.bodyText, term),
    );
    if (fuzzy) conditions.push(fuzzy);
  }

  const where = and(...conditions);
  const sortColumn =
    query.sort === 'sentAt'
      ? emailJobs.sentAt
      : query.sort === 'createdAt'
        ? emailJobs.createdAt
        : emailJobs.scheduledAt;

  const [totals, rows] = await Promise.all([
    db.select({ value: count() }).from(emailJobs).where(where),
    db
      .select({ id: emailJobs.id })
      .from(emailJobs)
      .where(where)
      .orderBy(query.order === 'asc' ? asc(sortColumn) : desc(sortColumn))
      .limit(size)
      .offset(from),
  ]);

  return {
    total: totals[0]?.value ?? 0,
    ids: rows.map((row) => row.id),
    engine: 'postgres',
  };
}

/** Rebuild the whole index from Postgres. Exposed as an admin endpoint. */
export async function reindexAll(userId?: string): Promise<number> {
  if (!(await isAvailable())) return 0;

  const senderRows = await db
    .select({ id: senders.id, email: senders.email })
    .from(senders);
  const senderEmailById = new Map(senderRows.map((row) => [row.id, row.email]));

  const batchSize = 500;
  let cursor: string | null = null;
  let indexed = 0;

  for (;;) {
    const conditions: SQL[] = [];
    if (userId) conditions.push(eq(emailJobs.userId, userId));
    if (cursor) conditions.push(gt(emailJobs.id, cursor));

    const batch: EmailJob[] = await db
      .select()
      .from(emailJobs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(emailJobs.id))
      .limit(batchSize);

    if (batch.length === 0) break;

    await bulkIndex(batch, senderEmailById);
    indexed += batch.length;
    cursor = batch[batch.length - 1]?.id ?? null;
    if (batch.length < batchSize) break;
  }

  await client.indices.refresh({ index: env.ELASTICSEARCH_INDEX }).catch(() => undefined);
  log.info({ indexed }, 'reindex complete');
  return indexed;
}
