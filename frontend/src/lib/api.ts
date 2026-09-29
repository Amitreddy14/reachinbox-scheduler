import type {
  AppUser,
  EmailListResponse,
  ScheduleRequest,
  ScheduleResponse,
  Sender,
  ServerConfig,
  SlackStatus,
  StatsResponse,
  ApiErrorBody,
} from '@/types';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const TOKEN_KEY = 'reachinbox.token';

/** The API session token lives in localStorage; the Google session lives in NextAuth. */
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    let code = 'REQUEST_FAILED';
    try {
      const body = (await response.json()) as ApiErrorBody;
      message = body.error?.message ?? message;
      code = body.error?.code ?? code;
    } catch {
      // Body was not JSON — keep the generic message.
    }
    throw new ApiError(response.status, code, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** SWR passes the key straight through, so this doubles as the default fetcher. */
export const fetcher = <T,>(path: string): Promise<T> => request<T>(path);

export const api = {
  exchangeGoogleToken: (idToken: string) =>
    request<{ token: string; user: AppUser }>('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ idToken }),
    }),

  me: () => request<{ user: AppUser }>('/api/auth/me'),

  config: () => request<ServerConfig>('/api/config'),

  listEmails: (params: {
    tab: 'scheduled' | 'sent';
    q?: string;
    page?: number;
    pageSize?: number;
  }) => {
    const search = new URLSearchParams({ tab: params.tab });
    if (params.q) search.set('q', params.q);
    if (params.page) search.set('page', String(params.page));
    if (params.pageSize) search.set('pageSize', String(params.pageSize));
    return request<EmailListResponse>(`/api/emails?${search.toString()}`);
  },

  stats: () => request<StatsResponse>('/api/emails/stats'),

  senders: () => request<{ senders: Sender[] }>('/api/senders'),

  schedule: (payload: ScheduleRequest) =>
    request<ScheduleResponse>('/api/emails/schedule', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  cancelEmail: (emailId: string) =>
    request<{ email: { id: string; status: string } }>(`/api/emails/${emailId}/cancel`, {
      method: 'POST',
    }),

  slackStatus: () => request<SlackStatus>('/api/slack/status'),

  slackInstallUrl: () =>
    request<{ url: string }>('/api/slack/install-url', { method: 'POST' }),

  slackDisconnect: () => request<{ connected: boolean }>('/api/slack/disconnect', { method: 'POST' }),

  slackTest: () =>
    request<{ delivered: boolean; message: string }>('/api/slack/test', { method: 'POST' }),
};
