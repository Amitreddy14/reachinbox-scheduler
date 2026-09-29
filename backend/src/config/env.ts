import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/**
 * Every tunable in this service is declared here and nowhere else. If a value
 * is not in this schema it is not configurable, and if it is in this schema it
 * is never hardcoded further down the stack.
 */

const booleanish = z
  .string()
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positiveInt(4000),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  BACKEND_URL: z.string().url().default('http://localhost:4000'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  ELASTICSEARCH_NODE: z.string().url().default('http://localhost:9200'),
  ELASTICSEARCH_INDEX: z.string().default('emails'),
  ELASTICSEARCH_FALLBACK_TO_DB: booleanish.default('true'),

  EMAIL_QUEUE_NAME: z.string().default('email-send'),
  WORKER_CONCURRENCY: positiveInt(5),
  RUN_WORKER_IN_API: booleanish.default('true'),
  MIN_GAP_MS_PER_SENDER: z.coerce.number().int().min(0).default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: positiveInt(200),
  MAX_EMAILS_PER_HOUR_GLOBAL: positiveInt(1000),
  JOB_ATTEMPTS: positiveInt(3),
  JOB_BACKOFF_MS: positiveInt(5000),
  KEEP_COMPLETED_JOBS: positiveInt(1000),
  KEEP_FAILED_JOBS: positiveInt(5000),

  GOOGLE_CLIENT_ID: z.string().default(''),

  SLACK_CLIENT_ID: z.string().default(''),
  SLACK_CLIENT_SECRET: z.string().default(''),
  SLACK_SCOPES: z.string().default('incoming-webhook,chat:write'),
  SLACK_FALLBACK_WEBHOOK_URL: z.string().default(''),

  ETHEREAL_AUTO_PROVISION: booleanish.default('true'),
  ETHEREAL_SENDER_COUNT: positiveInt(3),
  SMTP_HOST: z.string().default('smtp.ethereal.email'),
  SMTP_PORT: positiveInt(587),

  SENDER_1_EMAIL: z.string().default(''),
  SENDER_1_USER: z.string().default(''),
  SENDER_1_PASSWORD: z.string().default(''),
  SENDER_2_EMAIL: z.string().default(''),
  SENDER_2_USER: z.string().default(''),
  SENDER_2_PASSWORD: z.string().default(''),
  SENDER_3_EMAIL: z.string().default(''),
  SENDER_3_USER: z.string().default(''),
  SENDER_3_PASSWORD: z.string().default(''),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProduction = env.NODE_ENV === 'production';

/** SMTP identities declared statically in .env, if any. */
export interface StaticSenderConfig {
  email: string;
  user: string;
  password: string;
}

export function staticSenders(): StaticSenderConfig[] {
  const raw: StaticSenderConfig[] = [
    { email: env.SENDER_1_EMAIL, user: env.SENDER_1_USER, password: env.SENDER_1_PASSWORD },
    { email: env.SENDER_2_EMAIL, user: env.SENDER_2_USER, password: env.SENDER_2_PASSWORD },
    { email: env.SENDER_3_EMAIL, user: env.SENDER_3_USER, password: env.SENDER_3_PASSWORD },
  ];
  return raw.filter((s) => s.email.length > 0 && s.user.length > 0 && s.password.length > 0);
}
