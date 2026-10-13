/** In-memory admission receipts: retries share one mutation, status checks never replay it. */
import { createHash } from 'node:crypto';

export type DeliveryResult = { ok: boolean; error?: string; data?: Record<string, unknown> };
type Receipt = { fingerprint: string; createdAt: number; result?: DeliveryResult; promise: Promise<DeliveryResult> };

export class DeliveryReceipts {
  private records = new Map<string, Receipt>();
  constructor(private capacity = 4096, private ttlMs = 24 * 60 * 60_000, private now = Date.now) {}

  status(id: string): Record<string, unknown> {
    this.prune();
    const receipt = this.records.get(id);
    if (!receipt) return { state: 'unknown' };
    if (!receipt.result) return { state: 'sending' };
    return { state: receipt.result.ok ? 'accepted' : 'failed', result: receipt.result };
  }

  run(id: string, payload: unknown, operation: () => Promise<DeliveryResult>): Promise<DeliveryResult> {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(id))
      return Promise.resolve({ ok: false, error: 'invalid delivery ID' });
    this.prune();
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const existing = this.records.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return Promise.resolve({ ok: false, error: 'delivery ID was already used for a different message' });
      return existing.promise;
    }
    // Never evict an in-flight or unexpired receipt to make room: that would
    // silently make a retry eligible to execute twice.
    if (this.records.size >= this.capacity)
      return Promise.resolve({ ok: false, error: 'delivery receipt capacity reached; message was not accepted' });
    const receipt = { fingerprint, createdAt: this.now() } as Receipt;
    receipt.promise = Promise.resolve().then(operation).catch(cause => ({
      ok: false, error: cause instanceof Error ? cause.message : String(cause),
    })).then(result => {
      // Slash commands may return large output; don't retain megabytes of it in
      // every receipt. The first caller still gets the full command result.
      receipt.result = JSON.stringify(result).length <= 8192 ? result : result.ok
        ? { ok: true, data: { accepted: true, deliveryResultOmitted: true } }
        : { ok: false, error: result.error?.slice(0, 4096) ?? 'command failed' };
      receipt.promise = Promise.resolve(receipt.result);
      return result;
    });
    this.records.set(id, receipt);
    return receipt.promise;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, receipt] of this.records)
      if (receipt.result && receipt.createdAt < cutoff) this.records.delete(id);
  }
}
