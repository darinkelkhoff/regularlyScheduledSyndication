const encoder = new TextEncoder();
const context = (owner: string) => encoder.encode(JSON.stringify(['regsched-source-v1', owner]));
function encode(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

/** Deployment key material is mandatory; no plaintext or fallback-key mode. */
export class SourceVault {
  #encryption: CryptoKey;
  #identity: CryptoKey;
  private constructor(encryption: CryptoKey, identity: CryptoKey) {
    this.#encryption = encryption;
    this.#identity = identity;
  }

  static async create(secret: Uint8Array<ArrayBuffer>): Promise<SourceVault> {
    if (secret.byteLength !== 32) throw new RangeError('Source encryption requires a 32-byte secret');
    const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const derive = (label: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('regsched-v1'), info: encoder.encode(label) });
    const encryption = await crypto.subtle.deriveKey(derive('source-encryption'), material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const identity = await crypto.subtle.deriveKey(derive('source-identity'), material,
      { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    return new SourceVault(encryption, identity);
  }

  async seal(owner: string, url: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(owner) }, this.#encryption, encoder.encode(url));
    return `v1.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
  }

  async open(owner: string, value: string): Promise<string> {
    try {
      const [version, iv, ciphertext, extra] = value.split('.');
      if (version !== 'v1' || !iv || !ciphertext || extra !== undefined) throw new Error();
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: context(owner) }, this.#encryption, decode(ciphertext));
      return new TextDecoder().decode(plaintext);
    } catch {
      throw new Error('Unable to decrypt source URL');
    }
  }

  async fingerprint(owner: string, url: string): Promise<string> {
    const signature = await crypto.subtle.sign('HMAC', this.#identity, encoder.encode(JSON.stringify([owner, url])));
    return encode(new Uint8Array(signature));
  }
}
