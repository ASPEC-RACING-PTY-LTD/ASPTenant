import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

/** Starts an ephemeral HTTP server for a Node request listener (Express app). */
export async function listen(app: RequestListener): Promise<TestServer> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export const listenExpress = listen;
