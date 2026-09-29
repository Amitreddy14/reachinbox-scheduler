import pino from 'pino';
import { env, isProduction } from './env';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
  base: { service: 'reachinbox-scheduler' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'smtpPassword',
      '*.smtpPassword',
      'botToken',
      '*.botToken',
      'webhookUrl',
      '*.webhookUrl',
    ],
    censor: '[redacted]',
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' },
      },
});

export function childLogger(scope: string) {
  return logger.child({ scope });
}

export const appEnv = env;
