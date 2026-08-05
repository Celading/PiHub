/**
 * Flat, type-safe message dictionary. `zhMessages` is the schema; `enMessages`
 * must provide exactly the same keys (enforced by `Record<MessageKey, string>`).
 * Protocol/content strings (tool names, agent replies) stay untranslated.
 */

export const zhMessages = {
  // brand
  'brand.name': 'PiHub',
  'brand.tagline': 'pi.dev agent console',
  'brand.slogan': '你的π，由此汇聚',

  // header
  'header.status.checking': '连接中',
  'header.status.online': '服务器在线',
  'header.status.offline': '服务器离线',
  'header.theme.dark': '深色',
  'header.theme.light': '浅色',
  'header.theme.toggle': '切换主题',

  // settings: language
  'settings.language': '语言',

  // sidebar
  'sidebar.new': '新建会话/任务',
  'sidebar.search': '搜索会话/内容',
  'sidebar.features': '自动化 / 技能 / 工程流',
  'sidebar.features.phase2': '二期',
  'sidebar.sessions': '会话',
  'sidebar.empty': '暂无会话',
  'sidebar.empty.search': '无匹配结果',
  'sidebar.help': '帮助',
  'sidebar.history': '历史',
  'sidebar.stats': '统计',
  'sidebar.settings': '设置',
  'sidebar.user.id': '自定义用户 ID',
  'sidebar.msgs': '条消息',

  // composer
  'composer.placeholder': '给 pi 发送消息…',
  'composer.placeholder.steer': '引导运行中的 agent…',
  'composer.hint': '回车发送 · Shift+回车换行',
  'composer.hint.steer': '引导模式 · 运行中',
  'composer.send': '发送',
  'composer.steer': '引导',
  'composer.abort': '中断',

  // model bar
  'modelbar.model': '模型',
  'modelbar.thinking': '思考',

  // chat page
  'chat.empty.title': 'π',
  'chat.empty.hint': '与 pi agent 开始对话，消息通过 RPC 桥实时流入。',
  'chat.queued': '队列：{steer} 引导 · {followUp} 跟进',
  'chat.error.prefix': '',

  // sessions
  'sessions.title': '会话',
  'sessions.hint.loading': '加载中…',
  'sessions.hint.empty': '~/.pi/agent/sessions 下暂无会话。',
  'sessions.refresh': '刷新',
  'sessions.back': '← 返回会话',
  'sessions.loading': '加载中…',
  'sessions.showAll': '显示全部（{count} 条离支）',
  'sessions.mainline': '仅主线',
  'sessions.entries': '条记录',
  'sessions.tokens': 'tokens',
  'sessions.tools': '次工具调用',
  'sessions.openSessionError': '无法打开会话',

  // stats
  'stats.title': '统计',
  'stats.sessions': '会话',
  'stats.messages': '消息',
  'stats.toolCalls': '工具调用',
  'stats.totalCost': '总成本',
  'stats.byModel': '按模型',
  'stats.byProvider': '按提供方',
  'stats.byDirectory': '按目录',
  'stats.user': '用户',
  'stats.assistant': '助手',

  // settings
  'settings.title': '设置',
  'settings.readonly': '只读 · ~/.pi/agent',
  'settings.agent': 'agent 设置',
  'settings.modelStore': '模型仓库',
  'settings.loading': '加载中…',
  'settings.empty': '未找到设置文件。',
  'settings.emptyModels': '未找到模型。',
} as const;

export type MessageKey = keyof typeof zhMessages;

export const enMessages: Record<MessageKey, string> = {
  'brand.name': 'PiHub',
  'brand.tagline': 'pi.dev agent console',
  'brand.slogan': 'Where π connects everything.',

  'header.status.checking': 'connecting',
  'header.status.online': 'server online',
  'header.status.offline': 'server offline',
  'header.theme.dark': 'dark',
  'header.theme.light': 'light',
  'header.theme.toggle': 'Toggle theme',

  'settings.language': 'Language',

  'sidebar.new': 'New session/task',
  'sidebar.search': 'Search sessions/content',
  'sidebar.features': 'Automation / Skills / Workflows',
  'sidebar.features.phase2': 'phase 2',
  'sidebar.sessions': 'sessions',
  'sidebar.empty': 'no sessions yet',
  'sidebar.empty.search': 'no match',
  'sidebar.help': 'Help',
  'sidebar.history': 'History',
  'sidebar.stats': 'Stats',
  'sidebar.settings': 'Settings',
  'sidebar.user.id': 'Custom user ID',
  'sidebar.msgs': 'msgs',

  'composer.placeholder': 'Message pi…',
  'composer.placeholder.steer': 'Steer the running agent…',
  'composer.hint': 'enter to send · shift+enter for newline',
  'composer.hint.steer': 'steer mode · running',
  'composer.send': 'send',
  'composer.steer': 'steer',
  'composer.abort': 'abort',

  'modelbar.model': 'model',
  'modelbar.thinking': 'thinking',

  'chat.empty.title': 'π',
  'chat.empty.hint': 'Start a conversation with the pi agent. Messages stream here in real time via the RPC bridge.',
  'chat.queued': 'queued: {steer} steer · {followUp} follow-up',
  'chat.error.prefix': '',

  'sessions.title': 'Sessions',
  'sessions.hint.loading': 'loading…',
  'sessions.hint.empty': 'No sessions found under ~/.pi/agent/sessions.',
  'sessions.refresh': 'refresh',
  'sessions.back': '← sessions',
  'sessions.loading': 'loading…',
  'sessions.showAll': 'show all ({count} off-branch)',
  'sessions.mainline': 'mainline only',
  'sessions.entries': 'entries',
  'sessions.tokens': 'tokens',
  'sessions.tools': 'tools',
  'sessions.openSessionError': 'failed to open session',

  'stats.title': 'Stats',
  'stats.sessions': 'sessions',
  'stats.messages': 'messages',
  'stats.toolCalls': 'tool calls',
  'stats.totalCost': 'total cost',
  'stats.byModel': 'by model',
  'stats.byProvider': 'by provider',
  'stats.byDirectory': 'by directory',
  'stats.user': 'user',
  'stats.assistant': 'assistant',

  'settings.title': 'Settings',
  'settings.readonly': 'read-only · ~/.pi/agent',
  'settings.agent': 'agent settings',
  'settings.modelStore': 'model store',
  'settings.loading': 'loading…',
  'settings.empty': 'No settings file found.',
  'settings.emptyModels': 'No models found.',
};

export const LOCALES = ['zh', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_STORAGE_KEY = 'pi-panel:locale';

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
