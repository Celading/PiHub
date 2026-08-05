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

  // sidebar collections (phase-3 batch)
  'sidebar.collections': '集合',
  'sidebar.ungrouped': '未分组',
  'sidebar.addCollection': '新建集合',
  'sidebar.collectionName': '集合名称',
  'sidebar.renameCollection': '重命名集合',
  'sidebar.deleteCollection': '删除集合',
  'sidebar.newBranch': '新增分支',
  'sidebar.archive': '归档',
  'sidebar.restore': '恢复',
  'sidebar.archived': '归档会话',
  'sidebar.emptyArchived': '无归档会话',

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

  // session actions (phase-2)
  'session.rename': '重命名',
  'session.rename.placeholder': '输入会话名称…',
  'session.rename.save': '保存',
  'session.rename.cancel': '取消',
  'session.clone': '克隆',
  'session.clone.done': '已克隆新会话',
  'session.fork': '分叉',
  'session.fork.done': '已从此处分叉',
  'session.stats': '统计',
  'session.stats.title': '会话统计',
  'session.stats.context': '上下文占用',
  'session.stats.percent': '占用 {percent}%',
  'session.compact': '压缩',
  'session.compact.done': '已请求压缩',
  'session.compacting': '压缩中…',
  'session.export': '导出',
  'session.export.done': '已导出 HTML',
  'session.autoCompact': '自动压缩',
  'session.saveModel': '保存',
  'session.save.done': '已保存为默认模型',

  // terminal (phase-2)
  'terminal.title': '终端',
  'terminal.placeholder': '输入 bash 命令…',
  'terminal.run': '运行',
  'terminal.abort': '中断',
  'terminal.hint': '命令经 pi bash 工具执行，输出实时回流',
  'terminal.noOutput': '暂无输出',

  // notifications
  'notify.settled.title': 'pi agent',
  'notify.settled.body': 'agent 已完成当前任务',

  // channels (custom providers) — phase-3
  'settings.channels': '渠道',
  'settings.channels.hint': '自定义 API 渠道与模型（写入 ~/.pi/agent/models.json）',
  'channels.addProvider': '添加渠道',
  'channels.removeProvider': '删除渠道',
  'channels.addModel': '添加模型',
  'channels.removeModel': '移除模型',
  'channels.save': '保存',
  'channels.saved': '已保存',
  'channels.empty': '暂无自定义渠道',
  'provider.name': '渠道名称',
  'provider.baseUrl': 'Base URL',
  'provider.apiKey': 'API Token',
  'provider.api': 'API 类型',
  'model.id': '模型 ID',
  'model.name': '模型名称',
  'model.contextWindow': '最大上下文',
  'model.maxTokens': '最大输出',
  'model.reasoning': '支持思考',
  'model.details': '详细',
  'model.inputTypes': '输入类型',

  // archived sessions
  'settings.archived': '归档会话',
  'settings.restore': '恢复',
  'settings.emptyArchived': '无归档会话',

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
  'settings.readonly': '本地 · ~/.pi/agent',
  'settings.agent': 'agent 设置',
  'settings.modelStore': '模型仓库',
  'settings.loading': '加载中…',
  'settings.empty': '未找到设置文件。',
  'settings.emptyModels': '未找到模型。',
  'settings.back': '返回主界面',

  // command palette
  'palette.title': '自动化 / 技能 / 工程流',
  'palette.search': '搜索命令…',
  'palette.commands': '个命令',
  'palette.empty': '暂无可用命令。',
  'palette.hint': '点击命令即向 agent 发送 /name 指令',
  'palette.close': '关闭 (Esc)',
  'palette.source.extension': '扩展命令',
  'palette.source.prompt': '提示词模板',
  'palette.source.skill': '技能',
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

  'sidebar.collections': 'Collections',
  'sidebar.ungrouped': 'Ungrouped',
  'sidebar.addCollection': 'New collection',
  'sidebar.collectionName': 'Collection name',
  'sidebar.renameCollection': 'Rename collection',
  'sidebar.deleteCollection': 'Delete collection',
  'sidebar.newBranch': 'New branch',
  'sidebar.archive': 'Archive',
  'sidebar.restore': 'Restore',
  'sidebar.archived': 'Archived sessions',
  'sidebar.emptyArchived': 'No archived sessions',

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

  'session.rename': 'Rename',
  'session.rename.placeholder': 'Session name…',
  'session.rename.save': 'Save',
  'session.rename.cancel': 'Cancel',
  'session.clone': 'Clone',
  'session.clone.done': 'Session cloned',
  'session.fork': 'Fork',
  'session.fork.done': 'Forked from here',
  'session.stats': 'Stats',
  'session.stats.title': 'Session stats',
  'session.stats.context': 'Context usage',
  'session.stats.percent': '{percent}% used',
  'session.compact': 'Compact',
  'session.compact.done': 'Compaction requested',
  'session.compacting': 'Compacting…',
  'session.export': 'Export',
  'session.export.done': 'Exported as HTML',
  'session.autoCompact': 'Auto-compact',
  'session.saveModel': 'Save',
  'session.save.done': 'Saved as default model',

  'terminal.title': 'Terminal',
  'terminal.placeholder': 'Enter bash command…',
  'terminal.run': 'Run',
  'terminal.abort': 'Abort',
  'terminal.hint': 'Commands run via the pi bash tool; output streams back live',
  'terminal.noOutput': 'No output yet',

  'notify.settled.title': 'pi agent',
  'notify.settled.body': 'The agent finished its current task',

  'settings.channels': 'Channels',
  'settings.channels.hint': 'Custom API channels and models (written to ~/.pi/agent/models.json)',
  'channels.addProvider': 'Add channel',
  'channels.removeProvider': 'Remove channel',
  'channels.addModel': 'Add model',
  'channels.removeModel': 'Remove model',
  'channels.save': 'Save',
  'channels.saved': 'Saved',
  'channels.empty': 'No custom channels yet',
  'provider.name': 'Channel name',
  'provider.baseUrl': 'Base URL',
  'provider.apiKey': 'API Token',
  'provider.api': 'API type',
  'model.id': 'Model ID',
  'model.name': 'Model name',
  'model.contextWindow': 'Max context',
  'model.maxTokens': 'Max output',
  'model.reasoning': 'Reasoning',
  'model.details': 'Details',
  'model.inputTypes': 'Input types',

  'settings.archived': 'Archived sessions',
  'settings.restore': 'Restore',
  'settings.emptyArchived': 'No archived sessions',

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
  'settings.readonly': 'local · ~/.pi/agent',
  'settings.agent': 'agent settings',
  'settings.modelStore': 'model store',
  'settings.loading': 'loading…',
  'settings.empty': 'No settings file found.',
  'settings.emptyModels': 'No models found.',
  'settings.back': 'Back to home',

  'palette.title': 'Automation / Skills / Workflows',
  'palette.search': 'Search commands…',
  'palette.commands': 'commands',
  'palette.empty': 'No commands available.',
  'palette.hint': 'Click a command to send /name to the agent',
  'palette.close': 'Close (Esc)',
  'palette.source.extension': 'extensions',
  'palette.source.prompt': 'prompt templates',
  'palette.source.skill': 'skills',
};

export const LOCALES = ['zh', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_STORAGE_KEY = 'pi-panel:locale';

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
