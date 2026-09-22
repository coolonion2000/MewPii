/** One parent-scoped snapshot for cards, summary and detail. @author coolonion */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export interface Presentation {
  effectiveState: string; stateSource: string; statusStale: boolean; updatedAt?: number;
  toolCallId?: string; title?: string;
  outcome?: 'reported-unmet';
  childSummary?: { total: number; completed: number };
  workflow?: { state: string; issue?: 'continuation' | 'timeout' | 'startup' | 'failed'; error?: string; startedAt?: number; updatedAt?: number; endedAt?: number };
  steps: { effectiveState: string; outcome?: 'reported-unmet'; key: string; runId?: string; currentTool?: string; updatedAt?: number }[];
}
export interface RunEntry {
  id: string; path: string; name?: string; cwd: string; parentSessionPath?: string;
  presentation: Presentation;
}
export interface RunDetail {
  runId: string; agent: string; task: string; state: string; cwd?: string;
  startedAt?: number; lastUpdate?: number; endedAt?: number; presentation: Presentation;
  previewStep?: number;
  preview?: { messages: { role: string; text: string; timestamp?: number; summary?: string; outputText?: string }[]; truncated: boolean; unavailable?: boolean };
  log: string;
  steps?: { key: string; state: string; sessionFile?: string; runId?: string; agent?: string; model?: string; tokens?: number; cost?: number; error?: string }[];
}
interface Store {
  runs: RunEntry[]; detail?: RunDetail; error: boolean; loading: boolean;
  selected?: string; step?: number; open: (id: string) => void; close: () => void; selectStep: (step: number) => void;
  setUsage: (visible: boolean) => void;
}
const empty: Store = { runs: [], error: false, loading: false, open() {}, close() {}, selectStep() {}, setUsage() {} };
export const SubagentContext = createContext<Store>(empty);
export const useSubagents = () => useContext(SubagentContext);

export function useSubagentStore(parent?: string) {
  const [selection, setSelection] = useState<{ parent: string; id: string; step?: number; usage?: boolean }>();
  const selected = selection?.parent === parent ? selection?.id : undefined;
  const step = selected ? selection?.step : undefined;
  const usage = Boolean(selected && selection?.usage);
  const [snapshot, setSnapshot] = useState<{ parent?: string; selected?: string; step?: number; runs: RunEntry[]; detail?: RunDetail; error: boolean }>({ runs: [], error: false });
  useEffect(() => {
    if (!parent) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let generation = 0;
    async function load() {
      if (disposed || document.hidden) return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const version = ++generation;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
      const get = async (url: string) => {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      };
      try {
        const [list, detail] = await Promise.all([
          get(`/api/subagent-runs?parent=${encodeURIComponent(parent!)}`),
          selected ? get(`/api/subagent-run?runId=${encodeURIComponent(selected)}&parent=${encodeURIComponent(parent!)}${step === undefined ? '' : `&step=${step}`}${usage ? '&usage=1' : ''}`) : undefined,
        ]);
        if (disposed || version !== generation) return;
        const unconfirmed: Presentation = { effectiveState: 'unknown', stateSource: 'unconfirmed', statusStale: true, steps: [] };
        const runs: RunEntry[] = (list.runs ?? []).map((run: RunEntry) => ({ ...run, presentation: run.presentation ?? unconfirmed }));
        if (detail && !detail.presentation) detail.presentation = unconfirmed;
        setSnapshot({ parent, selected, step, runs: runs.map(run => run.id === detail?.runId ? { ...run, presentation: detail.presentation } : run), detail, error: false });
      } catch {
        if (disposed || (controller.signal.aborted && !timedOut) || version !== generation) return;
        setSnapshot(previous => ({ ...previous, error: true }));
      } finally {
        clearTimeout(timeout);
        if (!disposed && version === generation && !document.hidden) timer = setTimeout(load, selected ? 3000 : 5000);
      }
    }
    const visibility = () => {
      clearTimeout(timer); generation++; request?.abort();
      if (!document.hidden) void load();
    };
    void load();
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; generation++; clearTimeout(timer); request?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [parent, selected, step, usage]);
  const open = useCallback((id: string) => { if (parent) setSelection({ parent, id }); }, [parent]);
  const close = useCallback(() => setSelection(undefined), []);
  const selectStep = useCallback((next: number) => { if (parent && selected) setSelection({ parent, id: selected, step: next, usage: false }); }, [parent, selected]);
  const setUsage = useCallback((visible: boolean) => setSelection(previous => previous ? { ...previous, usage: visible } : previous), []);
  return useMemo<Store>(() => ({
    runs: snapshot.parent === parent ? snapshot.runs : [],
    detail: snapshot.parent === parent && snapshot.selected === selected && snapshot.step === step ? snapshot.detail : undefined,
    loading: snapshot.parent !== parent || snapshot.selected !== selected || snapshot.step !== step,
    error: snapshot.error,
    selected, step,
    open, close, selectStep, setUsage,
  }), [snapshot, parent, selected, step, open, close, selectStep, setUsage]);
}
