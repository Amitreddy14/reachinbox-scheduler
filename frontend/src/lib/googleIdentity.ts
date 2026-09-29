/**
 * Thin wrapper over Google Identity Services.
 *
 * GIS is loaded from Google's own CDN, renders Google's official button and
 * returns a signed OpenID Connect ID token. That token is what the Express API
 * verifies — no client secret ever reaches the browser, and the backend never
 * has to trust a profile object the frontend made up.
 */

export interface GoogleCredentialResponse {
  credential: string;
  select_by?: string;
}

interface GoogleAccountsId {
  initialize: (config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    ux_mode?: 'popup' | 'redirect';
  }) => void;
  renderButton: (
    parent: HTMLElement,
    options: {
      type?: 'standard' | 'icon';
      theme?: 'outline' | 'filled_blue' | 'filled_black';
      size?: 'small' | 'medium' | 'large';
      text?: 'signin_with' | 'signup_with' | 'continue_with';
      shape?: 'rectangular' | 'pill' | 'circle' | 'square';
      logo_alignment?: 'left' | 'center';
      width?: number;
    },
  ) => void;
  disableAutoSelect: () => void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

const SCRIPT_ID = 'google-identity-services';
const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

let loader: Promise<GoogleAccountsId> | null = null;

export function loadGoogleIdentity(): Promise<GoogleAccountsId> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Identity Services needs a browser'));
  }
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (loader) return loader;

  loader = new Promise<GoogleAccountsId>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;

    const onReady = () => {
      const accounts = window.google?.accounts?.id;
      if (accounts) resolve(accounts);
      else reject(new Error('Google Identity Services loaded but exposed no API'));
    };

    if (existing) {
      existing.addEventListener('load', onReady, { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('Could not load Google Identity Services')),
        { once: true },
      );
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = onReady;
    script.onerror = () => {
      loader = null;
      reject(new Error('Could not load Google Identity Services'));
    };
    document.head.appendChild(script);
  });

  return loader;
}

export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';
