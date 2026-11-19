import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
const base64 = (value: Uint8Array | string) => Buffer.from(value).toString('base64url');
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest();

/** Software authenticator for exercising the real server verifier, not a browser/device substitute. */
export class Authenticator {
  id = randomBytes(32);
  keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  counter = 0;
  register(challenge: string, origin = 'http://localhost:8787', rpID = 'localhost', uv = true): RegistrationResponseJSON {
    const publicKey = this.keys.publicKey.export({ format: 'jwk' });
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(publicKey.x!, 'base64url')], [-3, Buffer.from(publicKey.y!, 'base64url')],
    ]));
    const length = Buffer.alloc(2); length.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([hash(rpID), Buffer.from([uv ? 0x45 : 0x41]), Buffer.alloc(4), Buffer.alloc(16), length, this.id, cose]);
    const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, string>>([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', authData],
    ]));
    return {
      id: base64(this.id), rawId: base64(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: base64(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false })), attestationObject: base64(attestation), transports: ['internal'] },
    };
  }
  authenticate(challenge: string, origin = 'http://localhost:8787', rpID = 'localhost', uv = true): AuthenticationResponseJSON {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([hash(rpID), Buffer.from([uv ? 0x05 : 0x01]), counter]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, hash(clientData)]), this.keys.privateKey);
    return {
      id: base64(this.id), rawId: base64(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: base64(clientData), authenticatorData: base64(authData), signature: base64(signature) },
    };
  }
}
