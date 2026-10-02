import { createClientIpResolver, type TrustProxy } from '@aspec/rate-limit';
import type { AppConfig } from '../config.js';
import { trustedProxyList } from '../config.js';

export function createPlatformIpResolver(config: AppConfig) {
  const trusted = trustedProxyList(config);
  const trustProxy: TrustProxy = trusted.length > 0 ? trusted : false;
  const resolve = createClientIpResolver({ trustProxy });

  return (remoteAddress: string | undefined, header: (name: string) => string | undefined) => {
    if (trusted.length > 0) {
      const cloudflare = header('cf-connecting-ip')?.trim();
      if (cloudflare) return cloudflare;
    }
    return resolve(remoteAddress, header);
  };
}
