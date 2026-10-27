import { useEffect, useState } from 'react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Adds the manifest and service worker that make /mail/ installable as an app. */
export function registerMailApp(): void {
  if (!document.querySelector('link[rel="manifest"]')) {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = '/mail.webmanifest';
    document.head.append(link);
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    void navigator.serviceWorker.register('/mail-sw.js', { scope: '/mail/' }).catch(() => {
      // Without a service worker the app still works in the browser; it just cannot be installed.
    });
  }
}

/**
 * The browser's install prompt, once it offers one (Chrome and Edge on desktop and Android).
 * Returns a function that shows it, or null when the app is installed or cannot be.
 */
export function useInstallPrompt(): (() => void) | null {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  useEffect(() => {
    registerMailApp();
    const onPrompt = (prompt: Event) => {
      prompt.preventDefault();
      setEvent(prompt as InstallPromptEvent);
    };
    const onInstalled = () => setEvent(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  if (!event) return null;
  return () => {
    void event.prompt().then(() => setEvent(null));
  };
}
