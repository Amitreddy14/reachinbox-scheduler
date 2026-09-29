'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, clearToken, getToken, setToken } from '@/lib/api';
import { loadGoogleIdentity } from '@/lib/googleIdentity';
import type { AppUser } from '@/types';

export type AuthState = 'loading' | 'unauthenticated' | 'ready' | 'error';

interface AuthContextValue {
  state: AuthState;
  user: AppUser | null;
  error: string | null;
  /** Called with the Google ID token from the Sign in with Google button. */
  signInWithGoogle: (credential: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>('loading');
  const [user, setUser] = useState<AppUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * On boot, a stored API token is revalidated against /api/auth/me rather than
   * trusted. That way a token left behind by a previous run — or one signed
   * with a JWT_SECRET the server no longer uses — lands the user back on the
   * login screen instead of on a dashboard that 401s on every request.
   */
  useEffect(() => {
    let cancelled = false;

    if (!getToken()) {
      setState('unauthenticated');
      return;
    }

    void (async () => {
      try {
        const { user: me } = await api.me();
        if (cancelled) return;
        setUser(me);
        setState('ready');
      } catch {
        if (cancelled) return;
        clearToken();
        setUser(null);
        setState('unauthenticated');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const signInWithGoogle = useCallback(async (credential: string) => {
    setState('loading');
    try {
      const result = await api.exchangeGoogleToken(credential);
      setToken(result.token);
      setUser(result.user);
      setError(null);
      setState('ready');
    } catch (err) {
      clearToken();
      setError(err instanceof Error ? err.message : 'Could not reach the scheduler API');
      setState('error');
      throw err;
    }
  }, []);

  const signOut = useCallback(() => {
    clearToken();
    setUser(null);
    setError(null);
    setState('unauthenticated');
    // Stops Google from silently re-signing the user in on the next visit.
    void loadGoogleIdentity()
      .then((accounts) => accounts.disableAutoSelect())
      .catch(() => undefined);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ state, user, error, signInWithGoogle, signOut }),
    [state, user, error, signInWithGoogle, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
