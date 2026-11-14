import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from './alert';
import { Button } from './button';

/**
 * Cloudflare Turnstile widget (decision register D32).
 *
 * Renders nothing when no site key is configured. Enforcement is a server
 * decision: production fails closed without keys, while local development and
 * CI run without a challenge. See `docs/security/turnstile.md`.
 *
 * The token is written to a hidden `cf-turnstile-response` field so ordinary
 * form serialisation carries it. A page can ask for a fresh token after a
 * failed submit by dispatching `engage:turnstile-reset` on `window`.
 */

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: Record<string, unknown>,
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SELECTOR = 'script[data-engage-turnstile]';
let apiPromise: Promise<TurnstileApi> | undefined;

function loadTurnstileApi(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const waitForApi = (attempt = 0) => {
      if (window.turnstile) {
        resolve(window.turnstile);
        return;
      }
      if (attempt > 50) {
        reject(new Error('Turnstile did not initialise.'));
        return;
      }
      window.setTimeout(() => waitForApi(attempt + 1), 100);
    };

    const existing = document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR);
    if (existing?.dataset.loaded === 'true') {
      waitForApi();
      return;
    }

    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      waitForApi();
    }, { once: true });
    script.addEventListener('error', () => {
      reject(new Error('Turnstile could not load.'));
    }, { once: true });

    if (!existing) {
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.engageTurnstile = 'true';
      document.head.appendChild(script);
    }
  }).catch((error) => {
    // Allow a later retry to try loading the script again.
    apiPromise = undefined;
    throw error;
  });

  return apiPromise;
}

export interface TurnstileProps {
  /** `PUBLIC_TURNSTILE_SITE_KEY`. Nothing renders when this is empty. */
  siteKey?: string;
  /** Turnstile action name; must match the server's expectation. */
  action: string;
  className?: string;
}

export function Turnstile({ siteKey, action, className }: TurnstileProps) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const [token, setToken] = useState('');
  const [failure, setFailure] = useState<'' | 'expired' | 'error'>('');
  const [attempt, setAttempt] = useState(0);
  const hintId = useId();

  const reset = useCallback(() => {
    setToken('');
    setFailure('');
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!siteKey || !container.current) return;
    let cancelled = false;
    const element = container.current;

    loadTurnstileApi()
      .then((api) => {
        if (cancelled) return;
        element.replaceChildren();
        widgetId.current = api.render(element, {
          sitekey: siteKey,
          action,
          theme: 'auto',
          callback: (value: string) => {
            setToken(value);
            setFailure('');
          },
          'expired-callback': () => {
            setToken('');
            setFailure('expired');
          },
          'timeout-callback': () => {
            setToken('');
            setFailure('expired');
          },
          'error-callback': () => {
            setToken('');
            setFailure('error');
            return true;
          },
        });
      })
      .catch(() => {
        if (!cancelled) setFailure('error');
      });

    return () => {
      cancelled = true;
      const id = widgetId.current;
      widgetId.current = undefined;
      // Leave the DOM alone when React is only unmounting the island.
      if (id && window.turnstile) {
        try {
          window.turnstile.remove(id);
        } catch {
          // A widget that is already gone needs no cleanup.
        }
      }
    };
  }, [siteKey, action, attempt]);

  useEffect(() => {
    if (!siteKey) return;
    const handler = () => reset();
    window.addEventListener('engage:turnstile-reset', handler);
    return () => window.removeEventListener('engage:turnstile-reset', handler);
  }, [reset, siteKey]);

  if (!siteKey) return null;

  return (
    <div className={cn('grid gap-2', className)}>
      <p id={hintId} className="text-sm text-muted-foreground">
        Quick check that you’re human.
      </p>
      <div
        ref={container}
        role="group"
        aria-labelledby={hintId}
        className="min-h-[65px]"
        data-turnstile-action={action}
      />
      <input type="hidden" name="cf-turnstile-response" value={token} readOnly />
      {failure ? (
        <Alert variant="warning">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>
              {failure === 'expired'
                ? 'The verification check expired.'
                : 'The verification check couldn’t load.'}
            </span>
            <Button type="button" size="sm" variant="outline" onClick={reset}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export default Turnstile;
