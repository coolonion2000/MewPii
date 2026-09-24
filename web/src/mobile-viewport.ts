/** Keep the composer inside the visible area when a phone keyboard overlays the layout viewport. */
export function trackMobileViewport(win: Window = window): () => void {
  const root = win.document.documentElement;
  const visual = win.visualViewport;
  let frame = 0;
  const update = () => {
    frame = 0;
    if (win.innerWidth > 700) {
      root.style.removeProperty('--mobile-viewport-height');
      root.style.removeProperty('--mobile-viewport-top');
      return;
    }
    // Browser pinch zoom is user-controlled; do not relayout the app while zooming.
    if (visual && Math.abs(visual.scale - 1) > .01) return;
    root.style.setProperty('--mobile-viewport-height', `${visual?.height ?? win.innerHeight}px`);
    root.style.setProperty('--mobile-viewport-top', `${visual?.offsetTop ?? 0}px`);
  };
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(update); };
  update();
  win.addEventListener('resize', schedule);
  visual?.addEventListener('resize', schedule);
  visual?.addEventListener('scroll', schedule);
  return () => {
    win.cancelAnimationFrame(frame);
    win.removeEventListener('resize', schedule);
    visual?.removeEventListener('resize', schedule);
    visual?.removeEventListener('scroll', schedule);
    root.style.removeProperty('--mobile-viewport-height');
    root.style.removeProperty('--mobile-viewport-top');
  };
}
