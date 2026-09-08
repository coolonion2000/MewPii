/** Reuse Pi's settings component and persistence in the headless Web bridge. @author coolonion */
import { SettingsSelectorComponent, type AgentSession, type SettingsConfig, type SettingsCallbacks } from "@earendil-works/pi-coding-agent";

// Pi does not export this process-wide transport setter from its public barrel.
// Resolve it relative to the installed SDK; the native-command parity test pins compatibility.
const { configureHttpDispatcher } = await import(new URL("./core/http-dispatcher.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as { configureHttpDispatcher(timeout: number): void };

export function createPiSettings(session: AgentSession, done: () => void) {
  const settings = session.settingsManager;
  const config: SettingsConfig = {
    autoCompact: session.autoCompactionEnabled,
    defaultModel: [settings.getDefaultProvider(), settings.getDefaultModel()].filter(Boolean).join("/") || "not set",
    currentModel: session.model,
    availableDefaultModels: session.modelRuntime.getAvailableSnapshot(),
    showImages: settings.getShowImages(),
    imageWidthCells: settings.getImageWidthCells(),
    autoResizeImages: settings.getImageAutoResize(),
    blockImages: settings.getBlockImages(),
    enableSkillCommands: settings.getEnableSkillCommands(),
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    transport: settings.getTransport(),
    httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
    thinkingLevel: settings.getDefaultThinkingLevel() ?? "medium",
    availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    modelThinkingLevels: settings.getAllModelThinkingLevels(),
    currentTheme: settings.getThemeSetting() || "dark",
    terminalTheme: "dark",
    availableThemes: ["dark", "light", ...session.resourceLoader.getThemes().themes.flatMap(theme => theme.name ? [theme.name] : [])],
    hideThinkingBlock: settings.getHideThinkingBlock(),
    mermaidRenderingMode: settings.getMermaidRenderingMode(),
    collapseChangelog: settings.getCollapseChangelog(),
    enableInstallTelemetry: settings.getEnableInstallTelemetry(),
    doubleEscapeAction: settings.getDoubleEscapeAction(),
    treeFilterMode: settings.getTreeFilterMode(),
    showHardwareCursor: settings.getShowHardwareCursor(),
    showCacheMissNotices: settings.getShowCacheMissNotices(),
    defaultProjectTrust: settings.getDefaultProjectTrust(),
    editorPaddingX: settings.getEditorPaddingX(),
    outputPad: settings.getOutputPad(),
    autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
    quietStartup: settings.getQuietStartup(),
    clearOnShrink: settings.getClearOnShrink(),
    showTerminalProgress: settings.getShowTerminalProgress(),
    tuiMode: settings.getTuiMode(),
    fullscreenExitOutput: settings.getFullscreenExitOutput(),
    fullscreenScrollbar: settings.getFullscreenScrollbar(),
    fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
    warnings: settings.getWarnings(),

  };
  const callbacks: SettingsCallbacks = {
    onShowImagesChange: value => settings.setShowImages(value),
    onImageWidthCellsChange: value => settings.setImageWidthCells(value),
    onBlockImagesChange: value => settings.setBlockImages(value),
    onEnableSkillCommandsChange: value => settings.setEnableSkillCommands(value),
    onHideThinkingBlockChange: value => settings.setHideThinkingBlock(value),
    onMermaidRenderingModeChange: value => settings.setMermaidRenderingMode(value),
    onShowCacheMissNoticesChange: value => settings.setShowCacheMissNotices(value),
    onCollapseChangelogChange: value => settings.setCollapseChangelog(value),
    onEnableInstallTelemetryChange: value => settings.setEnableInstallTelemetry(value),
    onDoubleEscapeActionChange: value => settings.setDoubleEscapeAction(value),
    onTreeFilterModeChange: value => settings.setTreeFilterMode(value),
    onShowHardwareCursorChange: value => settings.setShowHardwareCursor(value),
    onEditorPaddingXChange: value => settings.setEditorPaddingX(value),
    onOutputPadChange: value => settings.setOutputPad(value),
    onAutocompleteMaxVisibleChange: value => settings.setAutocompleteMaxVisible(value),
    onQuietStartupChange: value => settings.setQuietStartup(value),
    onDefaultProjectTrustChange: value => settings.setDefaultProjectTrust(value),
    onClearOnShrinkChange: value => settings.setClearOnShrink(value),
    onShowTerminalProgressChange: value => settings.setShowTerminalProgress(value),
    onTuiModeChange: value => settings.setTuiMode(value),
    onFullscreenExitOutputChange: value => settings.setFullscreenExitOutput(value),
    onFullscreenScrollbarChange: value => settings.setFullscreenScrollbar(value),
    onFullscreenCopyOnSelectChange: value => settings.setFullscreenCopyOnSelect(value),
    onWarningsChange: value => settings.setWarnings(value),
    onThemeChange: value => settings.setTheme(value),
    onAutoCompactChange: value => session.setAutoCompactionEnabled(value),
    onAutoResizeImagesChange: value => settings.setImageAutoResize(value),
    onSteeringModeChange: value => session.setSteeringMode(value),
    onFollowUpModeChange: value => session.setFollowUpMode(value),
    onTransportChange: value => { settings.setTransport(value); session.agent.transport = value; },
    onHttpIdleTimeoutMsChange: value => { settings.setHttpIdleTimeoutMs(value); configureHttpDispatcher(value); },
    onModelThinkingLevelChange: (provider, id, level) => {
      settings.setModelThinkingLevel(provider, id, level);
      if (session.model?.provider === provider && session.model.id === id) session.setThinkingLevel(level);
    },
    onModelThinkingLevelRemove: (provider, id) => {
      settings.removeModelThinkingLevel(provider, id);
      if (session.model?.provider === provider && session.model.id === id)
        session.setThinkingLevel(settings.getDefaultThinkingLevel() ?? "medium");
    },
    onCancel: done,
  };
  const component = new SettingsSelectorComponent(config, callbacks);
  return { render: (width: number) => component.render(width), invalidate: () => component.invalidate(),
    handleInput: (data: string) => component.getSettingsList().handleInput(data) };
}
