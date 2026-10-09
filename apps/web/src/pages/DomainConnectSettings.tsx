import { useCallback, useEffect, useState } from 'react';
import { type DomainConnectSettings, getDomainConnect, saveDomainConnect } from '../api.js';

/** Signing settings for Domain Connect (the Verify pop-up on Domains). */
export function DomainConnectSettingsPanel() {
  const [settings, setSettings] = useState<DomainConnectSettings | null>(null);
  const [providerId, setProviderId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [keyId, setKeyId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const apply = useCallback((next: DomainConnectSettings) => {
    setSettings(next);
    setProviderId(next.providerId);
    setServiceId(next.serviceId);
    setKeyId(next.keyId);
  }, []);

  useEffect(() => {
    void getDomainConnect()
      .then(apply)
      .catch(() => setSettings(null));
  }, [apply]);

  if (!settings) return null;

  const save = (generateKey: boolean) =>
    void saveDomainConnect({
      providerId,
      serviceId,
      keyId,
      ...(privateKey.trim() ? { privateKey } : {}),
      ...(generateKey ? { generateKey: true } : {}),
    })
      .then((next) => {
        apply(next);
        setPrivateKey('');
        setMessage(
          generateKey ? 'New key pair generated. Publish the TXT record below.' : 'Saved.',
        );
      })
      .catch((err: unknown) => setMessage(err instanceof Error ? err.message : String(err)));

  return (
    <section className="panel">
      <h2>Domain Connect</h2>
      <p className="muted">
        Verify on the Domains page opens your DNS provider (for example Cloudflare) in a pop-up to
        add the verification and mail records. Requests are signed with this key. The template is in
        deploy/domainconnect and must be onboarded with each DNS provider.
      </p>
      <p>
        Status:{' '}
        <span className={`badge ${settings.configured ? 'badge-ok' : 'badge-warn'}`}>
          {settings.configured ? 'Signing key set' : 'Not configured'}
        </span>
      </p>
      {message ? <p className="notice">{message}</p> : null}
      <div className="field">
        <label htmlFor="dc-provider">Provider ID</label>
        <input
          id="dc-provider"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="dc-service">Service ID</label>
        <input id="dc-service" value={serviceId} onChange={(e) => setServiceId(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="dc-key">Key ID (TXT host label)</label>
        <input id="dc-key" value={keyId} onChange={(e) => setKeyId(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="dc-pem">Private key (PEM, optional)</label>
        <textarea
          id="dc-pem"
          rows={3}
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
        />
      </div>
      <div className="btn-row">
        <button className="btn" type="button" onClick={() => save(false)}>
          Save
        </button>
        <button className="btn btn-ghost" type="button" onClick={() => save(true)}>
          Generate new key pair
        </button>
      </div>
      {settings.publicKeyTxt ? (
        <>
          <p>
            Publish this TXT record at{' '}
            <code>
              {settings.keyId}.{settings.providerId}
            </code>{' '}
            (the template's syncPubKeyDomain):
          </p>
          <pre className="code">{settings.publicKeyTxt}</pre>
        </>
      ) : null}
    </section>
  );
}
