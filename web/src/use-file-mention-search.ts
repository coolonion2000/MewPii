import { useEffect, useState } from 'react';
import { fixedAgentUrl } from './state-utils';
import { t } from './i18n';
export interface MentionCandidate { name: string; path: string; isDir: boolean }
interface Result { key: string; items: MentionCandidate[]; cwd: string; loading: boolean; error?: string; truncated?: boolean }
export function useFileMentionSearch(query: string | undefined, cwd: string, agent?: string) {
  const key = JSON.stringify([agent, cwd, query]);
  const [result, setResult] = useState<Result>({ key: '', items: [], cwd, loading: false });
  useEffect(() => {
    if (query === undefined) return;
    const controller = new AbortController();
    let disposed = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(async () => {
      timeout = setTimeout(() => controller.abort(), 10000);
      try {
        // URL object intentionally bypasses the global default-agent string rewriter.
        const url = new URL(fixedAgentUrl(`/api/files?mode=mention&cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}&hidden=0`, agent), location.origin);
        const response = await fetch(url, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
        if (!data.mentionSearch) throw Error(t('mentionServerUpdate'));
        if (!Array.isArray(data.items) || typeof data.cwd !== 'string') throw Error(t('mentionSearchFailed'));
        if (!disposed) setResult({ key, items: data.items, cwd: data.cwd, loading: false, truncated: Boolean(data.truncated) });
      } catch (error) {
        if (!disposed) setResult({ key, items: [], cwd, loading: false, error: error instanceof Error ? error.message : String(error) });
      } finally { clearTimeout(timeout); }
    }, 180);
    return () => { disposed = true; clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
  }, [key, query, cwd, agent]);
  return result.key === key ? result : { key, items: [], cwd, loading: query !== undefined };
}
