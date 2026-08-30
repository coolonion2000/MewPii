/**
 * Browser completion chime gated by a prior user gesture.
 * @author coolonion
 */
let audioContext: AudioContext | undefined;

function audioContextConstructor(): typeof AudioContext | undefined {
  const browserGlobal = globalThis as typeof globalThis & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return browserGlobal.AudioContext ?? browserGlobal.webkitAudioContext;
}

/** Unlock audio while handling a browser user gesture. */
export function armCompletionSound(): void {
  const AudioContextClass = audioContextConstructor();
  if (!AudioContextClass) return;
  audioContext ??= new AudioContextClass();
  if (audioContext.state === 'suspended') {
    void audioContext.resume().catch(() => undefined);
  }
}

/** A completion only chimes when the same run settles away from the foreground. */
export function shouldPlayCompletionSound(
  wasStreaming: boolean,
  isStreaming: boolean,
  visibility: DocumentVisibilityState,
  windowFocused: boolean,
): boolean {
  return wasStreaming && !isStreaming && (visibility !== 'visible' || !windowFocused);
}

/** Play a short bounded two-note chime. Returns false when audio is not unlocked. */
export function playCompletionSound(): boolean {
  const context = audioContext;
  if (!context || context.state !== 'running') return false;

  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(660, now);
  oscillator.frequency.setValueAtTime(880, now + 0.13);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.09, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.addEventListener('ended', () => {
    oscillator.disconnect();
    gain.disconnect();
  }, { once: true });
  oscillator.start(now);
  oscillator.stop(now + 0.33);
  return true;
}
