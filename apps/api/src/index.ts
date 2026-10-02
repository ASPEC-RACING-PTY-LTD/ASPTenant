import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadAppConfig } from './config.js';
import { closePlatform, createPlatform } from './platform.js';

const config = loadAppConfig();
const platform = await createPlatform({ config });
const app = createApp(platform);

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.listenHost,
    port: config.listenPort,
  },
  (info) => {
    platform.logger.info(
      { host: info.address, port: info.port },
      `${config.appName} control plane listening`,
    );
  },
);

const shutdown = async (signal: string) => {
  platform.logger.info({ signal }, 'shutting down');
  server.close();
  await closePlatform(platform);
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
