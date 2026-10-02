import type { JwtClaims, SessionCookie, SignJwtOptions, TestJwtSigner } from './auth.js';
import type { TestClient } from './client.js';
import { CookieJar } from './cookies.js';
import { invalidOption } from './errors.js';
import type { Subject } from './ports.js';

export type ActAsCredentials =
  | { token: string; scheme?: string }
  | { cookie: SessionCookie | readonly SessionCookie[] }
  | {
      subject: Subject;
      signer: TestJwtSigner;
      claims?: JwtClaims;
      signOptions?: Omit<SignJwtOptions, 'algorithm' | 'secret' | 'privateKey'>;
    };

/**
 * Returns a client view that acts as a user: a bearer token, a session cookie (in a separate
 * cookie jar so other views are not affected), or a JWT signed for a Subject.
 */
export function actAs(client: TestClient, credentials: ActAsCredentials): TestClient {
  if ('token' in credentials) {
    return client.withHeaders({
      authorization: `${credentials.scheme ?? 'Bearer'} ${credentials.token}`,
    });
  }
  if ('cookie' in credentials) {
    const jar = new CookieJar();
    const list: readonly SessionCookie[] = Array.isArray(credentials.cookie)
      ? credentials.cookie
      : [credentials.cookie as SessionCookie];
    for (const c of list) jar.setFromHeader(c.setCookieHeader);
    return client.withJar(jar);
  }
  if ('subject' in credentials) {
    return client.withBearer(
      credentials.signer.signFor(credentials.subject, credentials.claims, credentials.signOptions),
    );
  }
  throw invalidOption('credentials', 'pass { token }, { cookie } or { subject, signer }');
}
