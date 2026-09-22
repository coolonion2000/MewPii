/** Follow layout, not token events. Explicit user navigation always wins. @author coolonion */
export function followChatTail(viewport: HTMLElement, content: HTMLElement, onFollowing: (following: boolean) => void) {
  let following = true;
  let interacting = false;
  let disposed = false;
  let frame = 0;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const nearBottom = () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2;
  const setFollowing = (next: boolean) => {
    if (following === next) return;
    following = next;
    onFollowing(next);
  };
  const schedule = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!following || interacting || disposed) return;
      const bottom = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (Math.abs(viewport.scrollTop - bottom) > 1) viewport.scrollTop = bottom;
    });
  };
  const begin = () => { clearTimeout(releaseTimer); interacting = true; };
  const release = () => {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => { interacting = false; schedule(); }, 100);
  };
  const wheel = (event: WheelEvent) => {
    begin();
    // Cancel immediately, before a queued resize frame can pull the user down.
    if (event.deltaY < 0) setFollowing(false);
    release();
  };
  const key = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]')) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) {
      begin(); setFollowing(false); release();
    } else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) { begin(); release(); }
  };
  const scroll = () => {
    // Layout/scroll anchoring can generate scroll events too. They must not turn
    // off following before the ResizeObserver has settled the new content height.
    if (interacting || !following) setFollowing(nearBottom());
    if (following) schedule();
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(viewport);
  resize.observe(content);
  viewport.addEventListener('scroll', scroll, { passive: true });
  viewport.addEventListener('wheel', wheel, { passive: true });
  viewport.addEventListener('pointerdown', begin);
  viewport.addEventListener('touchmove', begin, { passive: true });
  viewport.addEventListener('keydown', key);
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('touchend', release);
  onFollowing(true);
  schedule();
  return {
    pause: begin,
    resume: release,
    jumpToBottom() { clearTimeout(releaseTimer); interacting = false; setFollowing(true); schedule(); },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(releaseTimer);
      resize.disconnect();
      viewport.removeEventListener('scroll', scroll);
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('pointerdown', begin);
      viewport.removeEventListener('touchmove', begin);
      viewport.removeEventListener('keydown', key);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('touchend', release);
    },
  };
}
