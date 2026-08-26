/**
 * client/bundle-entry.ts —— ModuleLoader bundle 工厂（打包脚本入口）。
 * scripts/build-client.mjs 把它打包成 lib/client.js（react 外置、xyflow 内联）。
 *
 * 挂载策略（对齐 @linxin666/dsh-ssh 的 DOM 注入模式）：
 *  - 侧栏：DOM 注入一个入口按钮（插在既有工具入口 family 之后），自愈重插
 *  - 面板：DOM 注入 conversation 列内 absolute 覆盖层（不透明 bg-base），
 *    激活时隐藏列内其他内容 —— 与 chat 内容页同构，不遮挡全局，不与任何
 *    overlay z-index 打架
 */

import { createElement } from 'react'
import type { ExplorerClient, PanelStore } from './store.js'
import { createExplorerClient, createPanelStore, usePanelStore } from './store.js'
import { App } from './App.js'
import styles from './styles.css'

export const CHANNEL = '/dsh-session-explorer'

// ── DOM 选择器（与 dsh-ssh 一致，按当前 shell 结构适配）─────
const SIDEBAR_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"]'
const CONVERSATION_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ENTRY_SELECTOR = '[data-dsh-session-explorer-entry]'
// 与其他面板插件的互斥 family（taskboard / ssh / mnemon / archive 等）
const FAMILY_SELECTOR = '[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-mnemon-entry], [data-dsh-session-archive-entry], [data-dsh-session-explorer-entry]'

const ACTIVE_ATTR = 'data-dsh-session-explorer-active'
const OTHER_ACTIVE_ATTRS = [
  'data-dsh-taskboard-active',
  'data-dsh-ssh-active',
  'data-dsh-mnemon-active',
  'data-dsh-session-archive-active',
]
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'session-explorer'

interface RpcLike {
  call?: (channel: string, method: string, payload?: unknown) => Promise<unknown>
}
interface ConnectionLike {
  rpc?: RpcLike
}
interface SessionsLike {
  open?: (id: string) => void
}
interface ClientCtxLike {
  connection?: ConnectionLike
  sessions?: SessionsLike
  effect?: (dispose: () => unknown, label: string) => void
  /** cordis client ctx：取注入的服务（locale 等）。 */
  get?: (service: string) => unknown
}

// ── 侧栏入口 ────────────────────────────────────────────────

function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector(SIDEBAR_SELECTOR)
  if (column === null) return undefined
  const root = column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild
  return root instanceof HTMLElement ? root : undefined
}

function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector('button[class*="newSession"]')
  if (nested instanceof HTMLButtonElement) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON' && child instanceof HTMLButtonElement) return child
  }
  return undefined
}

/** Outline 历史图标（stroke 1.5，与宿主侧栏导航图标同风格）。 */
const HISTORY_ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 4.75V8l2.25 1.5"/></svg>'

function createEntry(store: PanelStore, label: string): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute('data-dsh-session-explorer-entry', '')
  entry.setAttribute('data-dsh-plugin', 'dsh-session-explorer')
  entry.setAttribute('data-dsh-part', 'sidebar-entry')
  entry.className = 'sex-entry'
  entry.setAttribute('aria-label', label)
  entry.setAttribute('title', label)
  entry.innerHTML = '<span class="sex-entry-icon">' + HISTORY_ICON + '</span><span class="sex-entry-label">' + label + '</span>'
  entry.addEventListener('click', () => { store.toggle() })
  return entry
}

function placeEntry(root: HTMLElement, entry: HTMLElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = row !== null && row.parentElement === root ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.matches(FAMILY_SELECTOR),
    )
    const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling
    root.insertBefore(entry, anchor)
  }
  return true
}

function mountSidebarEntry(store: PanelStore, label: string): () => void {
  if (document.querySelector(ENTRY_SELECTOR) !== null) return () => {}
  const entry = createEntry(store, label)
  let root: HTMLElement | undefined
  let placed = false
  let rootObserver: MutationObserver | undefined
  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver?.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver?.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed && rootObserver === undefined) {
      rootObserver = new MutationObserver(() => {
        if (root === undefined || !root.isConnected) {
          placed = false
          tryPlace()
          return
        }
        if (!root.contains(entry)) placed = placeEntry(root, entry)
      })
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }
  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const syncActive = (): void => {
    if (store.getSnapshot().open) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribeActive = store.subscribe(syncActive)
  syncActive()
  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver?.disconnect()
    unsubscribeActive()
    entry.remove()
  }
}

// ── 面板（覆盖 conversation 列）─────────────────────────────

function conversationColumn(): HTMLElement | undefined {
  const column = document.querySelector(CONVERSATION_SELECTOR)
  return column instanceof HTMLElement ? column : undefined
}

interface ReactRootLike {
  render: (node: unknown) => void
  unmount: () => void
}

function mountPanel(
  client: ExplorerClient,
  store: PanelStore,
  onOpenSession: (id: string) => void,
  reactDomClient: { createRoot: (el: Element) => ReactRootLike },
  Tooltip?: unknown,
  locale?: unknown,
): () => void {
  let root: ReactRootLike | undefined
  let container: HTMLDivElement | undefined
  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      root?.unmount()
      root = undefined
      container.remove()
      container = undefined
    }
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshSessionExplorerView = ''
    container.dataset.dshPlugin = 'dsh-session-explorer'
    container.className = 'sex-panel-view'
    column.appendChild(container)
    root = reactDomClient.createRoot(container)
    root.render(createElement(App, {
      client,
      store,
      onOpenSession,
      onClose: () => { store.close() },
      Tooltip,
      locale,
    }))
  }
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // 兄弟面板只认识 'ssh' / 'taskboard' 两个 detail（mnemon 也是通过发这两个兼容
  // 事件来关它们）。本面板打开时：先发兼容事件关掉 ssh/taskboard/mnemon（带抑制旗标
  // 防止它们反过来关我们），再删它们的 html active attr，最后设自己的 active attr。
  let suppressCompatibilityClose = false
  const applyActive = (): void => {
    if (store.getSnapshot().open) {
      suppressCompatibilityClose = true
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'ssh' }))
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'taskboard' }))
      suppressCompatibilityClose = false
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }
  const onOtherActivate = (event: Event): void => {
    if (suppressCompatibilityClose || !store.getSnapshot().open) return
    const detail = (event as CustomEvent<string>).detail
    if (detail === 'taskboard' || detail === 'ssh' || detail === 'mnemon' || detail === 'session-archive') {
      store.close()
    }
  }
  const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="newSession"]'
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!store.getSnapshot().open) return
    const target = event.target
    if (target instanceof Element && target.closest(SIDEBAR_ROW_SELECTOR) !== null) store.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = store.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    container?.remove()
  }
}

/** ModuleLoader factory：返回 { apply, inject }。 */
export function factory(require: (spec: string) => unknown) {
  const bundleModule = { exports: {} as Record<string, unknown> }
  Object.defineProperty(bundleModule.exports, Symbol.toStringTag, { value: 'Module' })

  function apply(ctx: ClientCtxLike) {
    if (typeof document === 'undefined') return
    const reactDomClient = require('react-dom/client') as { createRoot: (el: Element) => ReactRootLike }
    const Tooltip = (require('@deepseek-ai/dsh-client-ui-primitives') as { Tooltip?: unknown })?.Tooltip

    // DSH Host locale 服务（注入词 @deepseek-ai/dsh-client-locale；缺省回退 navigator.language）
    const locale = ctx.get?.('locale') as { subscribe?: (fn: () => void) => () => void; getSnapshot?: () => { active: string; revision: number } } | undefined

    const client = createExplorerClient(ctx.connection, CHANNEL)
    const store = createPanelStore()
    const onOpenSession = (sessionId: string) => {
      ctx.sessions?.open?.(sessionId)
      store.close()
    }

    // CSS 幂等注入
    const tagId = 'dsh-session-explorer/styles.css'
    if (document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = tagId
      tag.textContent = styles
      document.head.appendChild(tag)
    }

    // 侧栏入口 label：跟随 locale（中文「会话浏览器」/ 英文「Session Explorer」）
    const entryLabel = (): string => {
      const active = locale?.getSnapshot?.()?.active
      return typeof active === 'string' && active.length > 0 && !active.toLowerCase().startsWith('zh') ? 'Session Explorer' : '会话浏览器'
    }
    let disposeEntry = () => {}
    const applyEntry = () => { disposeEntry(); disposeEntry = mountSidebarEntry(store, entryLabel()) }
    applyEntry()
    const unsubscribeLocale = locale?.subscribe?.(applyEntry)

    const disposePanel = mountPanel(client, store, onOpenSession, reactDomClient, Tooltip, locale)
    ctx.effect?.(() => () => {
      unsubscribeLocale?.()
      disposePanel()
      disposeEntry()
    }, 'dsh-session-explorer: sidebar workspace')
  }

  bundleModule.exports.apply = apply
  bundleModule.exports.inject = ['connection', 'sessions', 'locale']
  return bundleModule.exports
}
