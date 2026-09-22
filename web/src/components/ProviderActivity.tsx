/** A small isolated clock: no rerender of the long transcript every second. @author coolonion */
import { useEffect, useState } from 'react';
import type { ProviderRequestState } from '../types';
import { providerRequestLabel } from '../provider-request-state';

export default function ProviderActivity({ state, language }: { state: ProviderRequestState; language: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state]);
  return <div className="working-indicator" role="status">
    <span className="working-dot" />
    <span>{providerRequestLabel(state, language, now)}</span>
  </div>;
}
