/** Minimal i18n: zh (default for zh browsers) / en. */
export type Lang = 'zh' | 'en';

const dict = {
  zh: {
    newSession: '新会话',
    searchSessions: '搜索会话…',
    noSessions: '还没有会话',
    noMatch: '没有匹配的会话',
    messages: '条消息',
    justNow: '刚刚',
    minutesAgo: '分钟前',
    hoursAgo: '小时前',
    daysAgo: '天前',
    running: '运行中',
    selectOrNew: '选择左侧会话继续，或新建一个会话',
    startChat: '开始对话',
    piWorksIn: 'pi 会在该目录中工作：',
    sendPlaceholder: '给 pi 发送消息…',
    steerPlaceholder: '输入以介入当前运行（steer）…',
    send: '发送',
    abort: '中断运行',
    selectModel: '选择模型',
    thinking: '思考',
    noConfiguredModels: '没有已配置鉴权的模型',
    compact: '压缩',
    export: '导出',
    doubleClickRename: '双击重命名',
    context: '上下文',
    fork: '分支',
    forkTitle: '从这条消息分叉为新会话',
    editFromHere: '编辑',
    editTitle: '回到这条消息并编辑（会话内分支）',
    deleteSession: '删除会话',
    confirmDelete: '删除这个会话？此操作不可撤销。',
    thinkingProcess: '思考过程',
    input: '输入',
    output: '输出',
    executing: '执行中…',
    navChat: '会话',
    navFiles: '文件',
    navModels: '模型',
    refresh: '刷新',
    toLight: '切换到浅色',
    toDark: '切换到深色',
    // models page
    modelsTitle: '模型与 Provider',
    configured: '已配置',
    notConfigured: '未配置',
    setKey: '设置 API Key',
    saveKey: '保存',
    cancel: '取消',
    logout: '退出登录',
    keySaved: '已保存',
    reasoning: '推理',
    image: '图像',
    authSource: '来源',
    // files page
    filesTitle: '项目文件',
    filesTab: '文件',
    gitTab: 'Git',
    upload: '上传',
    noGit: '不是 Git 仓库',
    branch: '分支',
    changedFiles: '变更文件',
    noChanges: '没有变更',
    viewDiff: '查看 Diff',
    navResources: '资源',
    resourcesTitle: '技能与资源',
    skillsSection: '技能',
    extensionsSection: '扩展',
    promptsSection: '提示模板',
    attachImage: '添加图片',
  },
  en: {
    newSession: 'New session',
    searchSessions: 'Search sessions…',
    noSessions: 'No sessions yet',
    noMatch: 'No matching sessions',
    messages: 'messages',
    justNow: 'just now',
    minutesAgo: 'm ago',
    hoursAgo: 'h ago',
    daysAgo: 'd ago',
    running: 'Running',
    selectOrNew: 'Pick a session on the left, or start a new one',
    startChat: 'Start chatting',
    piWorksIn: 'pi works in:',
    sendPlaceholder: 'Message pi…',
    steerPlaceholder: 'Steer the running agent…',
    send: 'Send',
    abort: 'Stop',
    selectModel: 'Select model',
    thinking: 'Thinking',
    noConfiguredModels: 'No models with configured auth',
    compact: 'Compact',
    export: 'Export',
    doubleClickRename: 'Double-click to rename',
    context: 'Context',
    fork: 'Fork',
    forkTitle: 'Fork a new session from this message',
    editFromHere: 'Edit',
    editTitle: 'Go back to this message and edit (in-session branch)',
    deleteSession: 'Delete session',
    confirmDelete: 'Delete this session? This cannot be undone.',
    thinkingProcess: 'Thinking',
    input: 'Input',
    output: 'Output',
    executing: 'Running…',
    navChat: 'Chats',
    navFiles: 'Files',
    navModels: 'Models',
    refresh: 'Refresh',
    toLight: 'Switch to light',
    toDark: 'Switch to dark',
    modelsTitle: 'Models & Providers',
    configured: 'Configured',
    notConfigured: 'Not configured',
    setKey: 'Set API key',
    saveKey: 'Save',
    cancel: 'Cancel',
    logout: 'Log out',
    keySaved: 'Saved',
    reasoning: 'reasoning',
    image: 'image',
    authSource: 'source',
    filesTitle: 'Project files',
    filesTab: 'Files',
    gitTab: 'Git',
    upload: 'Upload',
    noGit: 'Not a git repository',
    branch: 'branch',
    changedFiles: 'Changed files',
    noChanges: 'No changes',
    viewDiff: 'View diff',
    navResources: 'Resources',
    resourcesTitle: 'Skills & Resources',
    skillsSection: 'Skills',
    extensionsSection: 'Extensions',
    promptsSection: 'Prompt templates',
    attachImage: 'Attach image',
  },
} as const;

export type I18nKey = keyof (typeof dict)['zh'];

let current: Lang = (() => {
  const saved = localStorage.getItem('pii-lang');
  if (saved === 'zh' || saved === 'en') return saved;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
})();

const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  localStorage.setItem('pii-lang', lang);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const fn of listeners) fn();
}

export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key: I18nKey): string {
  return dict[current][key] ?? dict.en[key] ?? key;
}
