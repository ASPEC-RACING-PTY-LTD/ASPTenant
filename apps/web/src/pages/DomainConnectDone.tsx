import { useEffect } from 'react';

/** Domain Connect returns here in the popup; tell the opener and close. */
export function DomainConnectDonePage() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    window.opener?.postMessage(
      { type: 'domain-connect', ok: !error, error: params.get('error_description') ?? error },
      window.location.origin,
    );
    setTimeout(() => window.close(), 300);
  }, []);
  return <p className="content">DNS changes submitted. You can close this window.</p>;
}
