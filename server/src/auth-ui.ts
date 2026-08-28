interface RenderScheduler {
  requestRender(): void;
}

export type WebAuthPrompt = {
  signal?: AbortSignal;
} & (
  | { type: 'text' | 'secret' | 'manual_code'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: readonly { id: string; label: string; description?: string }[] }
);

export type WebAuthEvent =
  | { type: 'info'; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'progress'; message: string };

interface PendingPrompt {
  prompt: WebAuthPrompt;
  resolve(value: string): void;
  reject(error: Error): void;
  onAbort?: () => void;
}

/** Keyboard-driven authentication component rendered through the web custom-UI bridge. */
export class AuthUiComponent {
  private readonly abortController = new AbortController();
  private readonly lines: string[] = [];
  private pending?: PendingPrompt;
  private input = '';
  private selected = 0;
  private completed = false;

  constructor(
    private readonly tui: RenderScheduler,
    private readonly providerName: string,
    private readonly methodName: string,
  ) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  markCompleted(): void {
    this.completed = true;
  }

  notify(event: WebAuthEvent): void {
    if (event.type === 'auth_url') {
      if (event.instructions) this.lines.push(event.instructions);
      this.lines.push(event.url);
    } else if (event.type === 'device_code') {
      this.lines.push(`Open: ${event.verificationUri}`);
      this.lines.push(`Code: ${event.userCode}`);
    } else if (event.type === 'info') {
      this.lines.push(event.message);
      for (const link of event.links ?? []) this.lines.push(`${link.label ? `${link.label}: ` : ''}${link.url}`);
    } else {
      this.lines.push(event.message);
    }
    if (this.lines.length > 100) this.lines.splice(0, this.lines.length - 100);
    this.tui.requestRender();
  }

  prompt(prompt: WebAuthPrompt): Promise<string> {
    if (this.pending) return Promise.reject(new Error('authentication already has a pending prompt'));
    if (this.signal.aborted) return Promise.reject(new Error('Login cancelled'));
    this.input = '';
    this.selected = 0;
    return new Promise<string>((resolve, reject) => {
      const pending: PendingPrompt = { prompt, resolve, reject };
      if (prompt.signal) {
        pending.onAbort = () => this.rejectPending(new Error('Login cancelled'));
        prompt.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.pending = pending;
      this.tui.requestRender();
    });
  }

  render(width: number): string[] {
    const out = [`Login · ${this.providerName}`, this.methodName, ''];
    out.push(...this.lines);
    const pending = this.pending;
    if (pending) {
      if (this.lines.length > 0) out.push('');
      out.push(pending.prompt.message);
      if (pending.prompt.type === 'select') {
        pending.prompt.options.forEach((option, index) => {
          const description = option.description ? ` — ${option.description}` : '';
          out.push(`${index === this.selected ? '> ' : '  '}${option.label}${description}`);
        });
        out.push('', '↑↓ select · Enter confirm · Esc cancel');
      } else {
        const value = pending.prompt.type === 'secret' ? '•'.repeat(Array.from(this.input).length) : this.input;
        out.push(`> ${value}▌`);
        if (pending.prompt.placeholder && !this.input) out.push(`  ${pending.prompt.placeholder}`);
        out.push('', 'Enter submit · Esc cancel');
      }
    } else if (!this.completed) {
      out.push('', 'Waiting for authentication…', 'Esc cancel');
    }
    return out.map((line) => line.length > width ? `${line.slice(0, Math.max(1, width - 1))}…` : line);
  }

  handleInput(data: string): void {
    if (data === '\u001b' || data === '\u0003') {
      this.cancel();
      return;
    }
    const pending = this.pending;
    if (!pending) return;
    if (pending.prompt.type === 'select') {
      if (data === '\u001b[A') this.selected = Math.max(0, this.selected - 1);
      else if (data === '\u001b[B') this.selected = Math.min(pending.prompt.options.length - 1, this.selected + 1);
      else if (data === '\r') {
        const selected = pending.prompt.options[this.selected];
        if (selected) this.resolvePending(selected.id);
      }
    } else if (data === '\r') {
      this.resolvePending(this.input);
    } else if (data === '\u007f' || data === '\u001b[3~') {
      this.input = Array.from(this.input).slice(0, -1).join('');
    } else if (!data.startsWith('\u001b') && !/[\u0000-\u001f\u007f]/.test(data)) {
      this.input += data;
    }
    this.tui.requestRender();
  }

  invalidate(): void {}

  dispose(): void {
    if (!this.completed) this.cancel();
  }

  private resolvePending(value: string): void {
    const pending = this.takePending();
    pending?.resolve(value);
  }

  private rejectPending(error: Error): void {
    const pending = this.takePending();
    pending?.reject(error);
  }

  private takePending(): PendingPrompt | undefined {
    const pending = this.pending;
    if (!pending) return undefined;
    if (pending.prompt.signal && pending.onAbort) pending.prompt.signal.removeEventListener('abort', pending.onAbort);
    this.pending = undefined;
    return pending;
  }

  private cancel(): void {
    if (!this.abortController.signal.aborted) this.abortController.abort();
    this.rejectPending(new Error('Login cancelled'));
    this.tui.requestRender();
  }
}
