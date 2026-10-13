/** Probe service liveness independently of model output or tool duration. */
export function watchServiceHealth(
  probe: (signal: AbortSignal) => Promise<void>,
  update: (unresponsive: boolean) => void,
  intervalMs = 10000,
  timeoutMs = 5000,
): () => void {
  let closed = false;
  let timer: ReturnType<typeof setTimeout>;
  let controller: AbortController | undefined;
  const tick = async () => {
    controller = new AbortController();
    const deadline = setTimeout(() => controller?.abort(), timeoutMs);
    try {
      await probe(controller.signal);
      if (!closed) update(false);
    } catch {
      if (!closed) update(true);
    } finally {
      clearTimeout(deadline);
      if (!closed) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, intervalMs);
  return () => { closed = true; clearTimeout(timer); controller?.abort(); };
}
