import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { WhatsAppConnectionStatus } from '../types';

/**
 * Live WhatsApp Web connection status via Server-Sent Events, with polling as a fallback.
 * Only reads status; it never starts the client (that happens on an explicit Connect).
 */
export function useWhatsAppStatus(): WhatsAppConnectionStatus | null {
  const [status, setStatus] = useState<WhatsAppConnectionStatus | null>(null);

  useEffect(() => {
    let pollTimer: number | null = null;
    const source = new EventSource('/api/whatsapp/events');

    source.addEventListener('status', event => {
      try {
        setStatus(JSON.parse((event as MessageEvent).data));
      } catch {
        // ignore malformed event
      }
    });

    source.onerror = () => {
      // EventSource retries by itself; poll meanwhile so the page never goes stale
      if (pollTimer === null) {
        pollTimer = window.setInterval(() => {
          api.getWhatsAppStatus().then(res => setStatus(res.status)).catch(() => {});
        }, 3000);
      }
    };
    source.onopen = () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    return () => {
      source.close();
      if (pollTimer !== null) window.clearInterval(pollTimer);
    };
  }, []);

  return status;
}
