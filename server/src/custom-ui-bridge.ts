import {
  initTheme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { CustomUiFrame, ServerMessage } from "./protocol.js";

// Headless web sessions still execute extension helpers such as keyHint(),
// which rely on pi's process-global theme even when no interactive TUI exists.
initTheme(undefined, false);

interface HeadlessComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  dispose?(): void;
  focused?: boolean;
}

export interface CustomUiHandle {
  hide(): void;
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  focus(): void;
  unfocus(): void;
  isFocused(): boolean;
}

export interface CustomUiOptions {
  overlay?: boolean;
  onHandle?: (handle: CustomUiHandle) => void;
}

interface HeadlessTui {
  readonly mode: "regular";
  children: HeadlessComponent[];
  terminal: object;
  readonly fullRedraws: number;
  addChild(component: HeadlessComponent): void;
  removeChild(component: HeadlessComponent): void;
  clear(): void;
  getShowHardwareCursor(): boolean;
  setShowHardwareCursor(enabled: boolean): void;
  getClearOnShrink(): boolean;
  setClearOnShrink(enabled: boolean): void;
  setFocus(component: HeadlessComponent | null): void;
  showOverlay(component: HeadlessComponent): CustomUiHandle;
  hideOverlay(): void;
  hasOverlay(): boolean;
  start(): void;
  stop(): void;
  render(width: number): string[];
  renderNow(): void;
  requestRender(): void;
  invalidate(): void;
  addInputListener(listener: InputListener): () => boolean;
  removeInputListener(listener: InputListener): boolean;
  onTerminalColorSchemeChange(): () => undefined;
  setTerminalColorSchemeNotifications(enabled: boolean): void;
  queryTerminalBackgroundColor(): Promise<undefined>;
  queryTerminalColorScheme(): Promise<undefined>;
}

export type CustomUiFactory<T> = (
  tui: HeadlessTui,
  theme: unknown,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => HeadlessComponent | Promise<HeadlessComponent>;

type InputListener = (
  data: string,
) => { consume?: boolean; data?: string } | undefined;

interface CustomUiSession {
  id: string;
  revision: number;
  width: number;
  overlay: boolean;
  hidden: boolean;
  focused: boolean;
  component?: HeadlessComponent;
  focusedComponent?: HeadlessComponent;
  currentFrame?: CustomUiFrame;
  inputListeners: Set<InputListener>;
  timer: NodeJS.Timeout;
  renderPending: boolean;
  settled: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => (text: string) => text,
  getBashModeBorderColor: () => (text: string) => text,
};

const KEY_DATA = {
  "tui.editor.cursorUp": ["\u001b[A"],
  "tui.editor.cursorDown": ["\u001b[B"],
  "tui.editor.cursorLeft": ["\u001b[D", "\u0002"],
  "tui.editor.cursorRight": ["\u001b[C", "\u0006"],
  "tui.editor.cursorLineStart": ["\u001b[H", "\u0001"],
  "tui.editor.cursorLineEnd": ["\u001b[F", "\u0005"],
  "tui.editor.deleteCharBackward": ["\u007f"],
  "tui.editor.deleteCharForward": ["\u001b[3~", "\u0004"],
  "tui.input.newLine": ["\u000a"],
  "tui.input.submit": ["\r"],
  "tui.input.tab": ["\t"],
  "tui.select.up": ["\u001b[A"],
  "tui.select.down": ["\u001b[B"],
  "tui.select.pageUp": ["\u001b[5~"],
  "tui.select.pageDown": ["\u001b[6~"],
  "tui.select.confirm": ["\r"],
  "tui.select.cancel": ["\u001b", "\u0003"],
} satisfies Record<string, readonly string[]>;

function createWebKeybindings(): KeybindingsManager {
  const names = {
    "tui.select.up": ["up"],
    "tui.select.down": ["down"],
    "tui.select.pageUp": ["pageUp"],
    "tui.select.pageDown": ["pageDown"],
    "tui.select.confirm": ["enter"],
    "tui.select.cancel": ["escape", "ctrl+c"],
    "tui.input.submit": ["enter"],
    "tui.input.tab": ["tab"],
  } satisfies Record<string, string[]>;
  const getKeys = (keybinding: string) =>
    names[keybinding as keyof typeof names] ?? [];
  // SAFETY: ctx.ui.custom consumers only use the public KeybindingsManager methods implemented below.
  return {
    matches(data: string, keybinding: string) {
      return (
        KEY_DATA[keybinding as keyof typeof KEY_DATA]?.includes(data) ?? false
      );
    },
    getKeys,
    getDefinition: (keybinding: string) => ({
      defaultKeys: getKeys(keybinding),
    }),
    getConflicts: () => [],
    setUserBindings: () => undefined,
    getUserBindings: () => ({}),
    getResolvedBindings: () => ({}),
    getEffectiveConfig: () => ({}),
    reload: () => undefined,
  } as unknown as KeybindingsManager;
}

/** Runs extension TUI components headlessly and transports rendered frames and keyboard input. */
export class CustomUiBridge {
  private active?: CustomUiSession;

  constructor(private readonly send: (message: ServerMessage) => void) {}

  get frame(): CustomUiFrame | undefined {
    return this.active?.hidden ? undefined : this.active?.currentFrame;
  }

  get isActive(): boolean {
    return this.active !== undefined;
  }

  request<T>(
    factory: CustomUiFactory<T>,
    options?: CustomUiOptions,
  ): Promise<T> {
    if (this.active)
      return Promise.reject(
        new Error("another custom UI request is already active"),
      );
    const id = crypto.randomUUID();
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const state: CustomUiSession = {
        id,
        revision: 0,
        width: 100,
        overlay: options?.overlay === true,
        hidden: false,
        focused: true,
        inputListeners: new Set(),
        renderPending: false,
        settled: false,
        timer: setTimeout(
          () => this.complete(id, undefined, "timeout"),
          10 * 60_000,
        ),
        // SAFETY: this state belongs exclusively to this generic request, so its completion value is T.
        resolve: (value) => resolvePromise(value as T),
        reject: rejectPromise,
      };
      this.active = state;
      console.log(
        `[ui] custom_opened requestId=${id} overlay=${state.overlay}`,
      );
      void this.mount(state, factory, options);
    });
  }

  input(requestId: string, data: string): boolean {
    const state = this.active;
    if (
      !state ||
      state.id !== requestId ||
      state.settled ||
      state.hidden ||
      !state.focused ||
      data.length > 8192
    )
      return false;
    try {
      let next = data;
      for (const listener of state.inputListeners) {
        const result = listener(next);
        if (typeof result?.data === "string") next = result.data;
        if (result?.consume) {
          this.requestRender(state);
          return true;
        }
      }
      (state.focusedComponent ?? state.component)?.handleInput?.(next);
      this.requestRender(state);
      return true;
    } catch (cause) {
      this.complete(requestId, undefined, "input_error", this.toError(cause));
      return false;
    }
  }

  resize(requestId: string, width: number): boolean {
    const state = this.active;
    if (
      !state ||
      state.id !== requestId ||
      state.settled ||
      !Number.isFinite(width)
    )
      return false;
    const next = Math.max(40, Math.min(180, Math.round(width)));
    if (next === state.width) return true;
    state.width = next;
    state.component?.invalidate();
    this.requestRender(state);
    return true;
  }

  cancel(requestId: string): boolean {
    const state = this.active;
    if (!state || state.id !== requestId || state.settled) return false;
    this.input(requestId, "\u001b");
    setTimeout(() => {
      if (this.active === state && !state.settled)
        this.complete(requestId, undefined, "cancelled");
    }, 250);
    return true;
  }

  dispose(): void {
    if (this.active)
      this.complete(this.active.id, undefined, "session_disposed");
  }

  private async mount<T>(
    state: CustomUiSession,
    factory: CustomUiFactory<T>,
    options?: CustomUiOptions,
  ): Promise<void> {
    try {
      const component = await factory(
        this.createTui(state),
        PLAIN_THEME,
        createWebKeybindings(),
        (value) => {
          this.complete(state.id, value, "done");
        },
      );
      if (state.settled) {
        component.dispose?.();
        return;
      }
      state.component = component;
      state.focusedComponent ??= component;
      if ("focused" in component) component.focused = true;
      options?.onHandle?.(this.createHandle(state));
      this.requestRender(state);
    } catch (cause) {
      this.complete(state.id, undefined, "factory_error", this.toError(cause));
    }
  }

  private createTui(state: CustomUiSession): HeadlessTui {
    const children: HeadlessComponent[] = [];
    const terminal = new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === "columns") return state.width;
          if (key === "rows") return 40;
          if (key === "isTTY") return false;
          return () => undefined;
        },
      },
    );
    const setFocus = (component: HeadlessComponent | null) => {
      if (state.focusedComponent && "focused" in state.focusedComponent)
        state.focusedComponent.focused = false;
      state.focusedComponent = component ?? undefined;
      if (component && "focused" in component) component.focused = true;
    };
    return {
      mode: "regular",
      children,
      terminal,
      fullRedraws: 0,
      addChild: (component) => {
        children.push(component);
      },
      removeChild: (component) => {
        const index = children.indexOf(component);
        if (index >= 0) children.splice(index, 1);
      },
      clear: () => {
        children.length = 0;
      },
      getShowHardwareCursor: () => false,
      setShowHardwareCursor: () => undefined,
      getClearOnShrink: () => true,
      setClearOnShrink: () => undefined,
      setFocus,
      showOverlay: (component) => {
        setFocus(component);
        return this.createHandle(state);
      },
      hideOverlay: () => this.setHidden(state, true),
      hasOverlay: () => state.overlay && !state.hidden,
      start: () => undefined,
      stop: () => undefined,
      render: (width) => state.component?.render(width) ?? [],
      renderNow: () => this.render(state),
      requestRender: () => this.requestRender(state),
      invalidate: () => state.component?.invalidate(),
      addInputListener: (listener) => {
        state.inputListeners.add(listener);
        return () => state.inputListeners.delete(listener);
      },
      removeInputListener: (listener) => state.inputListeners.delete(listener),
      onTerminalColorSchemeChange: () => () => undefined,
      setTerminalColorSchemeNotifications: () => undefined,
      queryTerminalBackgroundColor: async () => undefined,
      queryTerminalColorScheme: async () => undefined,
    };
  }

  private createHandle(state: CustomUiSession): CustomUiHandle {
    let permanentlyHidden = false;
    return {
      hide: () => {
        permanentlyHidden = true;
        this.setHidden(state, true);
      },
      setHidden: (hidden) => {
        if (!permanentlyHidden) this.setHidden(state, hidden);
      },
      isHidden: () => state.hidden,
      focus: () => {
        state.focused = true;
      },
      unfocus: () => {
        state.focused = false;
      },
      isFocused: () => state.focused,
    };
  }

  private setHidden(state: CustomUiSession, hidden: boolean): void {
    if (state.settled || state.hidden === hidden) return;
    state.hidden = hidden;
    if (hidden)
      this.send({
        type: "custom_ui_close",
        requestId: state.id,
        reason: "hidden",
      });
    else this.requestRender(state);
  }

  private requestRender(state: CustomUiSession): void {
    if (state.renderPending || state.settled || state.hidden) return;
    state.renderPending = true;
    queueMicrotask(() => {
      state.renderPending = false;
      this.render(state);
    });
  }

  private render(state: CustomUiSession): void {
    if (
      state.settled ||
      state.hidden ||
      !state.component ||
      this.active !== state
    )
      return;
    try {
      const lines = state.component
        .render(state.width)
        .slice(0, 500)
        .map((line) => line.slice(0, 20_000));
      state.currentFrame = {
        requestId: state.id,
        revision: ++state.revision,
        width: state.width,
        lines,
        overlay: state.overlay,
      };
      this.send({ type: "custom_ui_frame", frame: state.currentFrame });
    } catch (cause) {
      this.complete(state.id, undefined, "render_error", this.toError(cause));
    }
  }

  private complete(
    requestId: string,
    value: unknown,
    reason: string,
    error?: Error,
  ): void {
    const state = this.active;
    if (!state || state.id !== requestId || state.settled) return;
    state.settled = true;
    clearTimeout(state.timer);
    this.active = undefined;
    try {
      state.component?.dispose?.();
    } catch (cause) {
      console.error(`[ui] custom_dispose_failed requestId=${requestId}`, cause);
    }
    this.send({ type: "custom_ui_close", requestId, reason });
    if (error) {
      console.error(
        `[ui] custom_failed requestId=${requestId} reason=${reason} error=${JSON.stringify(error.message)}`,
      );
    } else {
      console.log(`[ui] custom_closed requestId=${requestId} reason=${reason}`);
    }
    if (error) state.reject(error);
    else state.resolve(value);
  }

  private toError(cause: unknown): Error {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
}
