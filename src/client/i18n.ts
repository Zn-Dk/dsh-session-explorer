/**
 * client/i18n.ts —— 中英双语文案表 + locale hook。
 *
 * 语言来源（按 skill 约定）：优先 DSH Host locale 服务（ctx.get('locale')，
 * LocaleRuntime：register/bind/subscribe/getSnapshot），不可用时回退
 * navigator.language + 内置表。不做手动语言设置项。
 */

import { useSyncExternalStore } from 'react'

/** 全部用户可见文案（zh/en 键集合必须完全一致）。 */
export const I18N = {
  zh: {
    'backToSession': '返回会话',
    'backToSessionAria': '返回会话',
    'searchTab': '消息检索',
    'timelineTab': '时间线',
    'indexedStatus': '已索引 {indexed}/{total} 会话',
    'staleStatus': '{n} 个待同步，点击重建索引',
    'failedStatus': '{n} 个源日志损坏（无法索引）',
    'rebuildBtn': '重建索引',
    'rebuildingBtn': '重建中…',
    'helpAria': '重建索引说明',
    'helpTooltip': '重建索引：扫描全部历史会话并重建搜索索引。\n• 首次安装插件后自动触发，无需手动操作\n• 仅在索引库损坏、大批量新会话或怀疑索引不一致时使用\n• 日常搜索靠会话切换时的自动同步维护',
    'rebuildDoneIncremental': '增量重建完成：',
    'rebuildDoneFull': '全量重建完成：',
    'rebuildFailed': '重建失败：',
    'unknownError': '未知错误',
    'addedCount': '新增 {n}',
    'removedCount': '删除 {n}',
    'refreshedCount': '重刷 {n}',
    'skippedCount': '跳过 {n}',
    'succeededCount': '成功 {n}',
    'failedCount': '失败 {n}',
    'firstFailure': '首个失败：{msg}',
    'seqSep': '，',
    'loadingTimeline': '加载时间线…',
    'timelineFailed': '时间线加载失败',
    'dialogTitle': '重建搜索索引',
    'checkingHealth': '正在检查索引库健康状态…',
    'healthFailed': '索引库健康检查未通过：',
    'healthFailedHint': '建议选择「全量重建」以修复。',
    'healthOk': '索引库健康检查通过。',
    'healthCheckFailed': '健康检查失败',
    'incrementalLabel': '增量重建',
    'incrementalRecommended': '（推荐，较快）',
    'incrementalDesc': '仅新增未索引会话、清理已删除会话、重刷内容变化的会话；已索引且未变化的会话跳过。',
    'fullLabel': '全量重建',
    'fullSlow': '（较慢）',
    'fullDesc': '清空索引库并逐会话重建，可修复索引库损坏；历史会话多时可能需要较长时间。',
    'cancel': '取消',
    'startRebuild': '开始重建',
    'searchPlaceholder': '搜索会话消息（正文 / 工具名 / 参数 / 错误摘要）…',
    'kindUser': '用户',
    'kindAssistant': '助手',
    'kindTool': '工具',
    'kindSteering': '系统注入',
    'searchIdle': '输入关键词开始检索',
    'searchLoading': '检索中…',
    'searchNoResult': '没有匹配的消息',
    'searchFailed': '搜索失败',
    'noTitle': '(无标题)',
    'openSession': '打开会话',
    'loadMore': '加载更多',
    'previewLoading': '加载预览…',
    'previewFailed': '预览加载失败',
    'previewMissing': '该消息已不在索引中（会话可能已重建）。',
    'previewBack': '← 返回',
    'hitLabel': '命中',
    'noContent': '(无内容)',
    'timelineEmpty': '暂无会话',
  'timelineUnknownDir': '(未知目录)',
  'timelineSessionCount': '{n} 个会话',
  'timelineTurnCount': '{n} 条消息',
  'timelineOpenSession': '打开会话',
  'timelineNoTurns': '该会话暂无已索引消息',
  'timelineSearchPlaceholder': '搜索标题、目录、消息摘要…',
  'timelineAll': '全部',
  'timelineMain': '主代理',
  'timelineChild': '子代理',
  'timelineSort': '排序',
  'timelineSortUpdated': '最近更新',
  'timelineSortCreated': '创建时间',
  'timelineSortMessages': '消息数量',
  'timelineVisibleCount': '{n} 个会话',
  'timelineMessages': '{n} 条消息',
  'timelineTools': '{n} 个工具调用',
  'timelineNoSummary': '暂无消息摘要',
  'timelineLineage': '来源会话',
  'timelineRootSession': '顶层会话',
  'timelineNoAnchor': '摘要视图：不会跳转原始会话',
  },
  en: {
    'backToSession': 'Back to session',
    'backToSessionAria': 'Back to session',
    'searchTab': 'Search',
    'timelineTab': 'Timeline',
    'indexedStatus': '{indexed}/{total} sessions indexed',
    'staleStatus': '{n} pending sync, click rebuild',
    'failedStatus': '{n} source logs corrupt (unindexable)',
    'rebuildBtn': 'Rebuild',
    'rebuildingBtn': 'Rebuilding…',
    'helpAria': 'Rebuild index help',
    'helpTooltip': 'Rebuild index: rescan all session history and rebuild the search index.\n• Auto-triggered on first install, no manual action needed\n• Only needed when the index is corrupt, many new sessions, or suspected inconsistency\n• Daily search is maintained by auto-sync on session switches',
    'rebuildDoneIncremental': 'Incremental rebuild done: ',
    'rebuildDoneFull': 'Full rebuild done: ',
    'rebuildFailed': 'Rebuild failed: ',
    'unknownError': 'Unknown error',
    'addedCount': 'added {n}',
    'removedCount': 'removed {n}',
    'refreshedCount': 'refreshed {n}',
    'skippedCount': 'skipped {n}',
    'succeededCount': 'succeeded {n}',
    'failedCount': 'failed {n}',
    'firstFailure': 'first failure: {msg}',
    'seqSep': ', ',
    'loadingTimeline': 'Loading timeline…',
    'timelineFailed': 'Failed to load timeline',
    'dialogTitle': 'Rebuild Search Index',
    'checkingHealth': 'Checking index health…',
    'healthFailed': 'Index health check failed:',
    'healthFailedHint': 'A full rebuild is recommended to fix it.',
    'healthOk': 'Index health check passed.',
    'healthCheckFailed': 'Health check failed',
    'incrementalLabel': 'Incremental rebuild',
    'incrementalRecommended': ' (recommended, faster)',
    'incrementalDesc': 'Only indexes new sessions, removes deleted ones, and refreshes changed ones; unchanged indexed sessions are skipped.',
    'fullLabel': 'Full rebuild',
    'fullSlow': ' (slower)',
    'fullDesc': 'Clears the index and rebuilds session by session, fixing index corruption; may take a while with many sessions.',
    'cancel': 'Cancel',
    'startRebuild': 'Start rebuild',
    'searchPlaceholder': 'Search session messages (body / tool name / args / error summary)…',
    'kindUser': 'User',
    'kindAssistant': 'Assistant',
    'kindTool': 'Tool',
    'kindSteering': 'System',
    'searchIdle': 'Type a keyword to search',
    'searchLoading': 'Searching…',
    'searchNoResult': 'No matching messages',
    'searchFailed': 'Search failed',
    'noTitle': '(untitled)',
    'openSession': 'Open session',
    'loadMore': 'Load more',
    'previewLoading': 'Loading preview…',
    'previewFailed': 'Failed to load preview',
    'previewMissing': 'This message is no longer in the index (session may have been rebuilt).',
    'previewBack': '← Back',
    'hitLabel': 'hit',
    'noContent': '(no content)',
    'timelineEmpty': 'No sessions yet',
  'timelineUnknownDir': '(unknown directory)',
  'timelineSessionCount': '{n} sessions',
  'timelineTurnCount': '{n} messages',
  'timelineOpenSession': 'Open session',
  'timelineNoTurns': 'No indexed messages in this session',
  'timelineSearchPlaceholder': 'Search titles, directories, and message summaries…',
  'timelineAll': 'All',
  'timelineMain': 'Main agent',
  'timelineChild': 'Subagent',
  'timelineSort': 'Sort',
  'timelineSortUpdated': 'Recently updated',
  'timelineSortCreated': 'Created',
  'timelineSortMessages': 'Message count',
  'timelineVisibleCount': '{n} sessions',
  'timelineMessages': '{n} messages',
  'timelineTools': '{n} tool calls',
  'timelineNoSummary': 'No message summary',
  'timelineLineage': 'Parent session',
  'timelineRootSession': 'Root session',
  'timelineNoAnchor': 'Summary view: does not jump to the original session',
  },
} as const

export type I18nKey = keyof typeof I18N.zh

/** 读取当前语言（zh/en）。 */
export function resolveLocale(): 'zh' | 'en' {
  if (typeof navigator === 'undefined') return 'en'
  return (navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** 简易模板替换：{name} → 值。 */
export function formatTemplate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    return name in params ? String(params[name]) : match
  })
}

/** 最小 locale 服务形状（DSH LocaleRuntime 的子集）。 */
export interface LocaleServiceLike {
  subscribe?: (listener: () => void) => () => void
  getSnapshot?: () => { active: string; revision: number }
}

export interface I18nHandle {
  lang: 'zh' | 'en'
  t: (key: I18nKey, params?: Record<string, string | number>) => string
}

/**
 * 构造 i18n handle：优先读 DSH locale 服务（跟随 Host 语言偏好切换），
 * 不可用时回退 navigator.language + 内置表（同样响应语言变化）。
 */
export function createI18n(service?: LocaleServiceLike): I18nHandle {
  const getLang = (): 'zh' | 'en' => {
    const active = service?.getSnapshot?.()?.active
    if (typeof active === 'string' && active.length > 0) {
      return active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }
    return resolveLocale()
  }
  const dict = (lang: 'zh' | 'en'): Record<string, string> => I18N[lang] as unknown as Record<string, string>
  const t = (key: I18nKey, params?: Record<string, string | number>): string => {
    const template = dict(getLang())[key] ?? I18N.en[key] ?? key
    return params ? formatTemplate(template, params) : template
  }
  return { lang: getLang(), t }
}

/** React hook：订阅 locale 变化，返回 { lang, t }。 */
export function useI18n(service?: LocaleServiceLike): I18nHandle {
  const subscribe = (listener: () => void) => {
    if (service?.subscribe) return service.subscribe(listener)
    if (typeof window !== 'undefined') {
      window.addEventListener('languagechange', listener)
      return () => { window.removeEventListener('languagechange', listener) }
    }
    return () => {}
  }
  const getSnapshot = () => {
    const active = service?.getSnapshot?.()?.active ?? ''
    const lang = active.length > 0 ? active : resolveLocale()
    const revision = service?.getSnapshot?.()?.revision ?? 0
    return lang + ':' + revision
  }
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return createI18n(service)
}
