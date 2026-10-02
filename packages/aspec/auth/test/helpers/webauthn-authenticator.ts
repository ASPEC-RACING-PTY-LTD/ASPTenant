/**
 * Minimal software authenticator for WebAuthn ceremony tests.
 * ES256, "none" attestation, UP+UV flags, correct rpIdHash.
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

function b64url(data: Buffer | Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Minimal CBOR encoder for maps, bytes, text, ints and arrays used by WebAuthn. */
function cborEncode(value: unknown): Buffer {
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === 'boolean') return Buffer.from([value ? 0xf5 : 0xf4]);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('float unsupported');
    if (value >= 0) return cborUint(value, 0x00);
    return cborUint(-1 - value, 0x20);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborUint(bytes.length, 0x60), bytes]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([cborUint(bytes.length, 0x40), bytes]);
  }
  if (Array.isArray(value)) {
    const parts = [cborUint(value.length, 0x80)];
    for (const item of value) parts.push(cborEncode(item));
    return Buffer.concat(parts);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    // Prefer integer keys (COSE) when all keys parse as ints.
    const intKeys = entries.every(([k]) => /^-?\d+$/.test(k));
    const parts = [cborUint(entries.length, 0xa0)];
    if (intKeys) {
      const sorted = entries.map(([k, v]) => [Number(k), v] as const).sort((a, b) => a[0] - b[0]);
      for (const [k, v] of sorted) {
        parts.push(cborEncode(k));
        parts.push(cborEncode(v));
      }
    } else {
      for (const [k, v] of entries) {
        parts.push(cborEncode(k));
        parts.push(cborEncode(v));
      }
    }
    return Buffer.concat(parts);
  }
  throw new Error(`unsupported cbor type ${typeof value}`);
}

function cborUint(n: number, major: number): Buffer {
  if (n < 24) return Buffer.from([major | n]);
  if (n < 256) return Buffer.from([major | 24, n]);
  if (n < 65536) {
    const b = Buffer.alloc(3);
    b[0] = major | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = major | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

function coseEs256PublicKey(pub: KeyObject): Buffer {
  const jwk = pub.export({ format: 'jwk' }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new Error('bad jwk');
  return cborEncode({
    '1': 2, // kty EC2
    '3': -7, // alg ES256
    '-1': 1, // crv P-256
    '-2': Buffer.from(jwk.x, 'base64url'),
    '-3': Buffer.from(jwk.y, 'base64url'),
  });
}

export interface SoftwareAuthenticator {
  credentialId: Buffer;
  privateKey: KeyObject;
  publicKey: KeyObject;
  counter: number;
  create(input: { challenge: string; rpId: string; origin: string; userId?: Uint8Array }): {
    id: string;
    rawId: string;
    type: 'public-key';
    response: {
      clientDataJSON: string;
      attestationObject: string;
      transports: string[];
    };
    clientExtensionResults: Record<string, never>;
  };
  get(input: { challenge: string; rpId: string; origin: string }): {
    id: string;
    rawId: string;
    type: 'public-key';
    response: {
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
      userHandle?: string;
    };
    clientExtensionResults: Record<string, never>;
  };
}

export function createSoftwareAuthenticator(options?: {
  credentialId?: Buffer;
}): SoftwareAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = options?.credentialId ?? randomCredId();
  let counter = 0;

  const flags = (at: boolean) => {
    // bit0 UP, bit2 UV, bit6 AT
    return (0x01 | 0x04 | (at ? 0x40 : 0)) & 0xff;
  };

  const authData = (rpId: string, at: boolean, coseKey?: Buffer) => {
    const rpIdHash = sha256(rpId);
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32BE(counter);
    const parts: Buffer[] = [rpIdHash, Buffer.from([flags(at)]), counterBuf];
    if (at && coseKey) {
      const aaguid = Buffer.alloc(16);
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credentialId.length);
      parts.push(aaguid, len, credentialId, coseKey);
    }
    return Buffer.concat(parts);
  };

  const clientData = (type: string, challenge: string, origin: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');

  return {
    credentialId,
    privateKey,
    publicKey,
    get counter() {
      return counter;
    },
    set counter(v: number) {
      counter = v;
    },
    create({ challenge, rpId, origin }) {
      counter = 0;
      const cose = coseEs256PublicKey(publicKey);
      const authenticatorData = authData(rpId, true, cose);
      const cdj = clientData('webauthn.create', challenge, origin);
      const attestationObject = cborEncode({
        fmt: 'none',
        attStmt: {},
        authData: authenticatorData,
      });
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: b64url(cdj),
          attestationObject: b64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      };
    },
    get({ challenge, rpId, origin }) {
      counter += 1;
      const authenticatorData = authData(rpId, false);
      const cdj = clientData('webauthn.get', challenge, origin);
      const sig = sign('sha256', Buffer.concat([authenticatorData, sha256(cdj)]), privateKey);
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: b64url(cdj),
          authenticatorData: b64url(authenticatorData),
          signature: b64url(sig),
        },
        clientExtensionResults: {},
      };
    },
  };
}

function randomCredId(): Buffer {
  return randomBytes(16);
}
