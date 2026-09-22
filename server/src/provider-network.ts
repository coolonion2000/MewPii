/** Initialize the hosted SDK's network stack once, before loading sessions. @author coolonion */
import { SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';

const { configureHttpDispatcher } = await import(new URL('./core/http-dispatcher.js',
  import.meta.resolve('@earendil-works/pi-coding-agent')).href) as {
  configureHttpDispatcher(timeout: number): void;
};

let initialized = false;
export function initializeProviderNetwork() {
  if (initialized) return;
  const settings = SettingsManager.create(process.cwd(), getAgentDir());
  const proxy = (settings.getGlobalSettings() as { httpProxy?: string }).httpProxy?.trim();
  // Like Pi CLI: explicit environment settings win. Never log proxy credentials.
  if (proxy) {
    if (!process.env.HTTP_PROXY && !process.env.http_proxy) process.env.HTTP_PROXY = proxy;
    if (!process.env.HTTPS_PROXY && !process.env.https_proxy) process.env.HTTPS_PROXY = proxy;
  }
  const timeoutMs = settings.getHttpIdleTimeoutMs();
  configureHttpDispatcher(timeoutMs);
  initialized = true;
  console.info(`[mewpii] provider_network_initialized stack=pi_undici idle_timeout_ms=${timeoutMs} proxy_configured=${Boolean(proxy || process.env.HTTPS_PROXY || process.env.https_proxy)}`);
}
