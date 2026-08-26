/**
 * client/views/PreviewView.tsx —— 只读消息预览（焦点消息 + 上下文窗口）。
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { envelopeError, type ExplorerClient } from '../store.js'
import type { IndexableMessage, PreviewPage } from '../../protocol.js'
import { useI18n, type I18nKey, type LocaleServiceLike } from '../i18n.js'

export interface PreviewViewProps {
  client: ExplorerClient
  sessionId: string
  seq: number
  onBack: () => void
  onOpenSession: (sessionId: string) => void
  /** DSH Host locale 服务（缺省回退 navigator.language）。 */
  locale?: LocaleServiceLike
}

const KIND_KEYS: Record<string, I18nKey> = {
  user: 'kindUser',
  assistant: 'kindAssistant',
  tool: 'kindTool',
  steering: 'kindSteering',
}

const KIND_COLORS: Record<string, string> = {
  user: '#3b82f6',
  assistant: '#10b981',
  tool: '#f59e0b',
  steering: '#8b5cf6',
}

function formatTime(time: number): string {
  return new Date(time).toLocaleString()
}

function MessageRow({ message, focused, focusRef, t }: { message: IndexableMessage; focused: boolean; focusRef?: (el: HTMLDivElement | null) => void; t: (key: I18nKey) => string }) {
  const isUser = message.kind === 'user'
  const isTool = message.kind === 'tool'
  const label = KIND_KEYS[message.kind] ? t(KIND_KEYS[message.kind]) : message.kind
  const color = KIND_COLORS[message.kind] ?? '#888'
  const text = message.textMain || message.textTool || t('noContent')
  return (
    <div ref={focusRef} className={'sex-msg' + (focused ? ' sex-msg-focus' : '') + (isUser ? ' sex-msg-user' : '')}>
      <div className="sex-msg-head">
        <span className="sex-msg-kind" style={{ color }}>{label}</span>
        <span className="sex-msg-meta">
          {message.turn != null ? 'turn ' + message.turn + ' · ' : ''}
          {formatTime(message.time)}
          {focused ? ' · ' + t('hitLabel') : ''}
        </span>
      </div>
      <div className="sex-msg-body">{text}</div>
    </div>
  )
}

export function PreviewView({ client, sessionId, seq, onBack, onOpenSession, locale }: PreviewViewProps) {
  const { t } = useI18n(locale)
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; page: PreviewPage | null; error: string | null }>({ status: 'loading', page: null, error: null })
  const focusEl = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await client.preview(sessionId, seq, 20, 20)
        if (cancelled) return
        if (!res.ok) {
          setState({ status: 'error', page: null, error: envelopeError(res) || t('previewFailed') })
          return
        }
        setState({ status: 'ready', page: res.value ?? null, error: null })
      } catch (error) {
        if (!cancelled) setState({ status: 'error', page: null, error: String(error) })
      }
    })()
    return () => { cancelled = true }
  }, [client, sessionId, seq, t])

  // 焦点消息渲染后自动滚动定位到可视区中央（不跳转真实会话，仅面板内定位）。
  useEffect(() => {
    if (state.status === 'ready' && state.page && focusEl.current) {
      focusEl.current.scrollIntoView({ block: 'center', behavior: 'auto' })
    }
  }, [state])

  if (state.status === 'loading') return <div className="sex-empty">{t('previewLoading')}</div>
  if (state.status === 'error') return <div className="sex-error">{state.error}</div>
  const page = state.page
  if (!page) return <div className="sex-empty">{t('previewMissing')}</div>

  const focusSeq = page.focus.seq
  const before = page.context.filter((m) => m.seq < focusSeq)
  const after = page.context.filter((m) => m.seq > focusSeq)

  return (
    <div className="sex-preview">
      <div className="sex-preview-bar">
        <button type="button" className="sex-mini-btn" onClick={onBack}>{t('previewBack')}</button>
        <div className="sex-preview-title">
          <span className="sex-hit-title">{page.sessionTitle ?? t('noTitle')}</span>
          <span className="sex-hit-meta">{page.cwd ?? ''}</span>
        </div>
        <button type="button" className="sex-mini-btn" onClick={() => { onOpenSession(sessionId) }}>{t('openSession')}</button>
      </div>
      <div className="sex-preview-scroll">
        {before.map((message) => <MessageRow key={message.seq} message={message} focused={false} t={t} />)}
        <MessageRow message={page.focus} focused focusRef={(el) => { focusEl.current = el }} t={t} />
        {after.map((message) => <MessageRow key={message.seq} message={message} focused={false} t={t} />)}
      </div>
    </div>
  )
}
