import { useEffect } from 'react';

/**
 * Records a page arrival for the aggregate funnel. Sends only the invitation
 * slug and a stage, once per mount. No cookie, identifier or content.
 */
export default function FunnelBeacon({ initiativeSlug }: { initiativeSlug: string }) {
  useEffect(() => {
    fetch('/api/collaboration/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initiativeSlug, stage: 'view' }),
      keepalive: true,
    }).catch(() => {});
  }, [initiativeSlug]);

  return null;
}
