/** Shared by thumbnails and previews so MIME metadata cannot diverge. */
export function imageDataUrl(data: string, mimeType?: unknown): string {
  const mime = typeof mimeType === 'string' && /^image\/[a-z0-9.+-]+$/i.test(mimeType) ? mimeType : 'image/png';
  return `data:${mime};base64,${data}`;
}
export function imageFit(width: number, height: number, viewportWidth: number, viewportHeight: number): number {
  return Math.min(1, Math.max(1, viewportWidth - 40) / Math.max(1, width), Math.max(1, viewportHeight - 140) / Math.max(1, height));
}
export function clampImageZoom(zoom: number, fit: number): number {
  return Math.max(.25, Math.min(Math.max(5, 1 / fit), zoom));
}
