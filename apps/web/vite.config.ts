import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Web app manifest for the installable mail app at /mail/. Generated so the app name follows
 * VITE_MAIL_APP_NAME instead of being fixed in a static file.
 */
function mailManifest(name: string): Plugin {
  const manifest = JSON.stringify(
    {
      name,
      short_name: name,
      description: 'Email for your organisation.',
      id: '/mail/',
      start_url: '/mail/',
      scope: '/mail/',
      display: 'standalone',
      display_override: ['window-controls-overlay', 'standalone'],
      background_color: '#121826',
      theme_color: '#2b4ac7',
      icons: [
        { src: '/mail-icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/mail-icon-512.png', sizes: '512x512', type: 'image/png' },
        {
          src: '/mail-icon-512-maskable.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
      shortcuts: [{ name: 'New mail', url: '/mail/?compose=new' }],
    },
    null,
    2,
  );
  return {
    name: 'mail-manifest',
    configureServer(server) {
      server.middlewares.use('/mail.webmanifest', (_req, res) => {
        res.setHeader('content-type', 'application/manifest+json');
        res.end(manifest);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'mail.webmanifest', source: manifest });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), mailManifest(env.VITE_MAIL_APP_NAME || 'Mail')],
    server: {
      port: 5173,
      proxy: {
        '/api': 'http://127.0.0.1:3000',
        '/auth': 'http://127.0.0.1:3000',
        '/livez': 'http://127.0.0.1:3000',
        '/readyz': 'http://127.0.0.1:3000',
        '/healthz': 'http://127.0.0.1:3000',
      },
    },
  };
});
