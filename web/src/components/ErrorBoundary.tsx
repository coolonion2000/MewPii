import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';

interface Props {
  children: ReactNode;
  className?: string;
  onDismiss?: () => void;
  inline?: boolean;
}

interface State {
  error?: Error;
}

/** A rejected lazy import is cached by React and cannot recover via setState. */
export function isModuleLoadError(error: Error): boolean {
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (?:CSS )?chunk .+ failed|ChunkLoadError/i.test(error.message);
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
    const moduleLoadFailed = isModuleLoadError(error);
    const content = (
      <div className={`render-error-boundary ${this.props.className ?? ''}`} role="alert">
        <strong>{t(moduleLoadFailed ? 'moduleLoadError' : 'renderError')}</strong>
        {moduleLoadFailed && <span>{t('moduleLoadRecovery')}</span>}
        <span className="render-error-detail">{error.message}</span>
        <button className="btn btn-sm" onClick={() => {
          if (moduleLoadFailed) window.location.reload();
          else this.setState({ error: undefined });
        }}>
          {t(moduleLoadFailed ? 'reloadPage' : 'retry')}
        </button>
        {this.props.onDismiss && <button className="btn btn-sm" onClick={this.props.onDismiss}>{t('close')}</button>}
      </div>
    );
    // A failed optional dialog must leave the transcript/composer mounted.
    if (!this.props.onDismiss || this.props.inline) return content;
    return createPortal(
      <div className="modal-mask" onClick={this.props.onDismiss}>
        <div className="modal" onClick={(event) => event.stopPropagation()}>
          {content}
        </div>
      </div>,
      document.querySelector('.main') ?? document.body,
    );
  }
}
