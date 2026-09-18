import { useCallback, useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconDownloadOutline16, IconPanelLeftOutline16, IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../i18n/locales.ts'
import { getFrame, MOBILE_QUERY } from '../effects/phone-chrome.ts'

/** Wire contract of the lifetime-token endpoint (host half, src/token-usage.ts). */
interface TokensTotalBody {
  ok?: boolean
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Per-bucket breakdown carried alongside the lifetime total. */
interface TokensBreakdown {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

/** Display state of the lifetime-token counter. */
type TokensState =
  | { status: 'loading' }
  | { status: 'loaded'; total: number; breakdown: TokensBreakdown }
  | { status: 'failed' }

/** Full props for the sidebar footer action entry. */
export interface MobileDrawerFooterProps extends PropsRuntime<'sidebar.footer.action'>, PropsLocale<typeof NS> {
  /** Bound ctx.sessionLogDownload.download() for the current session. */
  downloadSessionLog: (sessionId: string) => void
  /** Bound ctx.layout.toggleSidebar(): the Files sheet closes the drawer. */
  toggleSidebar: () => void
  /**
   * Opens the host's own right-column Files tab (0.1.5+ sidebarRight service).
   * Returns false when the service is absent (old hosts), so the caller can
   * fall back to the dsh-web-ui explorer marker.
   */
  openHostFiles: () => boolean
}

/** Browser-locale compact form (1.2万 / 1.2M) for the pill, full form for the tooltip. */
function formatCompact(total: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(total)
}
function formatFull(total: number): string {
  return new Intl.NumberFormat(undefined).format(total)
}
/** Guard a wire field into a finite non-negative number (missing -> 0). */
function numOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Mobile-only drawer footer actions, relocated from the session header to the
 * drawer footer (beside Settings):
 * - Files + Session log sit on the FIRST row (each half-width).
 * - Total tokens spans the SECOND row, with the per-bucket breakdown
 *   (input / output / cache read / cache write / reasoning) rendered under the
 *   lifetime figure. Folded by the host half's `/api/mobile-nav.tokens.total`
 *   endpoint. Refreshes on tap. Loads only while the mobile query matches, so
 *   desktop never pays the corpus scan.
 * Hidden entirely on wide screens (CSS media query).
 */
export function MobileDrawerFooter({ useSessions, downloadSessionLog, toggleSidebar, openHostFiles, t }: MobileDrawerFooterProps) {
  const sessionId = useSessions((state) => state.current)
  const [tokens, setTokens] = useState<TokensState>({ status: 'loading' })

  const refreshTokens = useCallback((): void => {
    fetch('/api/mobile-nav.tokens.total')
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`)
        return res.json() as Promise<TokensTotalBody>
      })
      .then((body) => {
        if (body.ok === true && typeof body.totalTokens === 'number') {
          setTokens({
            status: 'loaded',
            total: body.totalTokens,
            breakdown: {
              input: numOr(body.inputTokens),
              output: numOr(body.outputTokens),
              cacheRead: numOr(body.cacheReadTokens),
              cacheWrite: numOr(body.cacheWriteTokens),
              reasoning: numOr(body.reasoningTokens),
            },
          })
        } else {
          setTokens({ status: 'failed' })
        }
      })
      .catch(() => setTokens({ status: 'failed' }))
  }, [])

  useEffect(() => {
    const query = matchMedia(MOBILE_QUERY)
    const sync = (): void => {
      if (query.matches) refreshTokens()
    }
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [refreshTokens])

  const openExplorer = (): void => {
    // Host-native right panel first (0.1.5+); it owns its own show/hide, so
    // just close the drawer afterwards and skip the marker dance.
    if (openHostFiles()) {
      toggleSidebar()
      return
    }
    // Fallback (dsh-web-ui): yield the preview sheet first (compat.css gives
    // preview precedence over explorer), then open the explorer and close
    // the drawer.
    getFrame()?.removeAttribute('data-aionui-preview-open')
    getFrame()?.setAttribute('data-aionui-explorer-open', '')
    toggleSidebar()
  }

  const tokensDisplay = tokens.status === 'loaded'
    ? formatCompact(tokens.total)
    : tokens.status === 'failed' ? '—' : '…'
  const tokensTitle = tokens.status === 'loaded'
    ? `${t('tokensTotal')} ${formatFull(tokens.total)}`
    : t('tokensTotal')

  return (
    <div data-mobile-nav="drawer-actions">
      <button
        type="button"
        data-mobile-nav="explorer"
        aria-label={t('files')}
        title={t('files')}
        onClick={openExplorer}
      >
        <IconPanelLeftOutline16 size={14} />
        <span>{t('files')}</span>
      </button>
      <button
        type="button"
        data-mobile-nav="session-log"
        aria-label={t('sessionLog')}
        title={t('sessionLog')}
        disabled={sessionId === undefined}
        onClick={() => {
          if (sessionId !== undefined) downloadSessionLog(sessionId)
        }}
      >
        <IconDownloadOutline16 size={14} />
        <span>{t('sessionLog')}</span>
      </button>
      <button
        type="button"
        data-mobile-nav="tokens-total"
        aria-label={tokensTitle}
        title={tokensTitle}
        onClick={refreshTokens}
      >
        <span className="tokens-main">
          <IconSparkle16 size={14} />
          <span>{t('tokensTotal')}</span>
          <span className="tokens-value">{tokensDisplay}</span>
        </span>
        {tokens.status === 'loaded' && (
          <span className="tokens-breakdown">
            <span>{`${t('tokInput')} ${formatCompact(tokens.breakdown.input)}`}</span>
            <span>{`${t('tokOutput')} ${formatCompact(tokens.breakdown.output)}`}</span>
            <span>{`${t('tokCacheRead')} ${formatCompact(tokens.breakdown.cacheRead)}`}</span>
            <span>{`${t('tokCacheWrite')} ${formatCompact(tokens.breakdown.cacheWrite)}`}</span>
            {tokens.breakdown.reasoning > 0 && (
              <span>{`${t('tokReasoning')} ${formatCompact(tokens.breakdown.reasoning)}`}</span>
            )}
          </span>
        )}
      </button>
    </div>
  )
}
