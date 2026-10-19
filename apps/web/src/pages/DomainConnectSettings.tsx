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

  const save = (mode: 'save' | 'generate' | 'remove') =>
    void saveDomainConnect({
      providerId,
      serviceId,
      keyId,
      ...(mode === 'save' && privateKey.trim() ? { privateKey } : {}),
      ...(mode === 'generate' ? { generateKey: true } : {}),
      ...(mode === 'remove' ? { removeKey: true } : {}),
    })
      .then((next) => {
        apply(next);
        setPrivateKey('');
        setMessage(
          mode === 'generate'
            ? 'New key pair generated. Publish the TXT record below.'
            : mode === 'remove'
              ? 'The signing key was removed. Domain Connect is off.'
              : 'Saved.',
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
        <button className="btn" type="button" onClick={() => save('save')}>
          Save
        </button>
        <button className="btn btn-ghost" type="button" onClick={() => save('generate')}>
          Generate new key pair
        </button>
        {settings.configured ? (
          <button
            className="btn btn-danger"
            type="button"
            onClick={() => {
              if (!window.confirm('Remove the signing key? Domain Connect stops working.')) return;
              save('remove');
            }}
          >
            Remove key
          </button>
        ) : null}
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
