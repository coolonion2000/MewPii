import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../i18n';

interface Props {
  children: ReactNode;
  className?: string;
}

interface State {
  error?: Error;
}

function reportRenderError(error: Error, info: ErrorInfo): void {
  console.error('[ui] render failed', error, info.componentStack);
  try {
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: error.message.slice(0, 2000),
        stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}`.slice(0, 4000),
        url: location.pathname,
        ts: Date.now(),
      }),
    }).catch(() => undefined);
  } catch {
    // Rendering must stay recoverable even when telemetry is unavailable.
  }
}

/** Prevent one malformed stream block from taking down the whole application. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportRenderError(error, info);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`render-error-boundary ${this.props.className ?? ''}`} role="alert">
        <strong>{t('renderError')}</strong>
        <span className="render-error-detail">{error.message}</span>
        <button className="btn btn-sm" onClick={() => this.setState({ error: undefined })}>
          {t('retry')}
        </button>
      </div>
    );
  }
}
