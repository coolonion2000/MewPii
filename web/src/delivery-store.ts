/** Only receipt IDs and one-way fingerprints are saved, never message/image content. */
export type StoredDelivery = {
  id: string;
  type: 'prompt' | 'steer' | 'followUp' | 'slash';
  state: 'sending' | 'unknown';
  updatedAt: number;
  fingerprint: string;
};

const key = 'mewpii.delivery-receipts.v1';
const fallback = new Map<string, StoredDelivery[]>();

export function canRecordDelivery(scope: string): boolean {
  const scopes = new Map<string, number>();
  try {
    const all = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    if (all && typeof all === 'object' && !Array.isArray(all))
      for (const [name, records] of Object.entries(all))
        if (Array.isArray(records)) scopes.set(name, records.length);
  } catch { /* Memory fallback is authoritative when storage is unavailable. */ }
  for (const [name, records] of fallback) scopes.set(name, records.length);
  return (scopes.get(scope) ?? 0) < 64 && [...scopes.values()].reduce((sum, count) => sum + count, 0) < 256;
}

export function readDeliveries(scope: string): StoredDelivery[] {
  if (fallback.has(scope)) return fallback.get(scope)!.map(item => ({ ...item }));
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? '{}')[scope];
    if (!Array.isArray(saved)) return [];
    return saved.filter((item): item is StoredDelivery => item &&
      typeof item.id === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(item.id) &&
      ['prompt', 'steer', 'followUp', 'slash'].includes(item.type) &&
      ['sending', 'unknown'].includes(item.state) && Number.isFinite(item.updatedAt) &&
      typeof item.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.fingerprint)).slice(0, 64)
      .map(item => ({ ...item, state: 'unknown' }));
  } catch { return []; }
}

export function writeDeliveries(scope: string, records: StoredDelivery[]): void {
  const saved = records.slice(0, 64).map(({ id, type, state, updatedAt, fingerprint }) => ({ id, type, state, updatedAt, fingerprint }));
  if (saved.length) fallback.set(scope, saved);
  else fallback.delete(scope);
  try {
    const all = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    if (!all || typeof all !== 'object' || Array.isArray(all)) return;
    if (saved.length) all[scope] = saved;
    else delete all[scope];
    sessionStorage.setItem(key, JSON.stringify(all));
  } catch { /* Private mode/quota: current-page receipts still survive view switching. */ }
}

// SHA-256 over UTF-8, with no dependency on WebCrypto's secure-context-only
// subtle API. LAN HTTP deployments need the same reload-safe fingerprint.
// This is a deduplication fingerprint, not an authentication primitive.
const constants = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];
const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
function* fingerprintBlocks(serialized: string): Generator<void, string> {
  const bytes = new TextEncoder().encode(serialized);
  const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(data.length - 4, (bytes.length * 8) >>> 0);
  const hash = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15], b = words[i - 2];
      words[i] = words[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,h].forEach((value, i) => { hash[i] += value; });
    // Yield between 128 KiB slices for the LAN HTTP asynchronous fallback.
    if ((offset + 64) % (128 * 1024) === 0) yield;
  }
  return Array.from(hash, value => value.toString(16).padStart(8, '0')).join('');
}

function fingerprintSync(serialized: string): string {
  const blocks = fingerprintBlocks(serialized);
  let block = blocks.next();
  while (!block.done) block = blocks.next();
  return block.value;
}

export function deliveryFingerprint(value: unknown): string {
  return fingerprintSync(JSON.stringify(value));
}

async function fingerprintAsync(serialized: string, useWebCrypto: boolean): Promise<string> {
  if (useWebCrypto && globalThis.crypto?.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
      return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    } catch { /* Restricted/older browsers use the same chunked algorithm below. */ }
  }
  const blocks = fingerprintBlocks(serialized);
  for (;;) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const block = blocks.next();
    if (block.done) return block.value;
  }
}

export function deliveryFingerprintAsync(value: unknown, useWebCrypto = true): Promise<string> {
  return fingerprintAsync(JSON.stringify(value), useWebCrypto);
}

/** Small drafts stay synchronous; image-heavy payloads never hash in one long task. */
export function deliveryFingerprintForSend(value: unknown): string | Promise<string> {
  const serialized = JSON.stringify(value);
  return serialized.length <= 256 * 1024 ? fingerprintSync(serialized) : fingerprintAsync(serialized, true);
}
