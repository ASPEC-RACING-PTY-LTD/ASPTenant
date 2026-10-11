import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadAppConfig } from './config.js';
import { createRequestListener } from './http/server.js';
import { closePlatform, createPlatform } from './platform.js';

const config = loadAppConfig();
const platform = await createPlatform({ config });
const app = createApp(platform);
platform.updates.start();
void platform.mailServers.start();
platform.imports.kick();
platform.backups.start();

const server = createServer(createRequestListener(platform, app));
server.listen(config.listenPort, config.listenHost, () => {
  platform.logger.info(
    { host: config.listenHost, port: config.listenPort },
    `${config.appName} control plane listening`,
  );
});

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
