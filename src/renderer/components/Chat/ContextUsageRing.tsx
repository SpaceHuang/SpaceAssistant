import { useEffect, useMemo, useState } from 'react'
import { Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import { useTypedSelector } from '../../hooks'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { ChatImageAttachment } from '../../../shared/domainTypes'
import {
  computeContextUsageDisplay,
  estimateTokensFromImageAttachments,
  resolveEffectiveMaximumContext
} from '../../../shared/contextUsageEstimate'
import { normalizeTokensLargestRemainder } from '../../../shared/usageAttribution'
import { effectiveMaxTokensForBuiltinToolLoop } from '../../../shared/llm/toolLoopMaxTokens'
import { resolveSessionModelBinding } from '../../services/sessionModelBinding'

const RING_SIZE = 28
const CENTER = RING_SIZE / 2
const RADIUS = 10
const STROKE_WIDTH = 3

function formatNum(n: number, locale: string): string {
  return n.toLocaleString(locale)
}

type RingSegment = {
  color: string
  dashLen: number
  dashOffset: number
}

type Props = {
  pendingImageAttachments?: ChatImageAttachment[]
  historyImageTokens?: number
  thinkingTokensToExclude?: number
}

/** usage_step_facts 归因列的渲染端最小投影（避免引入主进程模块）。 */
type LatestStepAttribution = {
  estimatorVersion: string | null
  systemTokens: number | null
  toolsTokens: number | null
  messageTokens: number | null
}

/** 在同一圆环上按顺序拼接：已用 | 输出预留 | 剩余（由底色轨道表示） */
export function buildContextRingSegments(
  usedRatio: number,
  reservedRatio: number,
  circumference: number
): RingSegment[] {
  const usedLen = circumference * usedRatio
  const reservedLen = circumference * reservedRatio
  const segments: RingSegment[] = []

  if (usedLen > 0) {
    segments.push({ color: 'var(--sa-primary)', dashLen: usedLen, dashOffset: 0 })
  }
  if (reservedLen > 0) {
    segments.push({ color: 'var(--sa-context-ring-reserved)', dashLen: reservedLen, dashOffset: -usedLen })
  }

  return segments
}

export function ContextUsageRing({
  pendingImageAttachments,
  historyImageTokens = 0,
  thinkingTokensToExclude = 0
}: Props) {
  const { t } = useTypedTranslation('contextUsage')
  const { i18n } = useTranslation()
  const lastUsage = useTypedSelector((s) => s.chat.lastUsage)
  const contextProjection = useTypedSelector((s) => s.chat.contextProjection)
  const config = useTypedSelector((s) => s.config.config)
  const sessionId = useTypedSelector((s) => s.chat.currentSessionId)
  const currentSession = useTypedSelector((s) => s.session.list.find((session) => session.id === sessionId))

  const pendingImageTokens = useMemo(() => {
    if (!pendingImageAttachments?.length) return 0
    return estimateTokensFromImageAttachments(pendingImageAttachments)
  }, [pendingImageAttachments])

  const currentModel = useMemo(() => {
    if (!config) return undefined
    const binding = resolveSessionModelBinding(config, currentSession)
    return config.models.find((model) => model.name === binding.modelName)
  }, [config, currentSession])

  const maximumContext = useMemo(() => {
    if (contextProjection) return contextProjection.contextWindow.tokens
    if (!config || !currentModel) return undefined
    const modelName = resolveSessionModelBinding(config, currentSession).modelName
    return resolveEffectiveMaximumContext(modelName, currentModel.maximumContext)
  }, [config, currentModel, currentSession])

  const effectiveOutputMax =
    config != null
      ? effectiveMaxTokensForBuiltinToolLoop(currentSession?.maxTokens ?? 4096)
      : contextProjection ? 0 : undefined

  const hasData =
    (lastUsage != null || contextProjection != null) &&
    maximumContext != null &&
    maximumContext > 0 &&
    effectiveOutputMax != null

  const display = useMemo(() => {
    if (!hasData || !maximumContext || effectiveOutputMax == null) return null
    const usage = lastUsage ?? { input_tokens: contextProjection?.projectedTokens ?? contextProjection?.surfaceTokens ?? 0, output_tokens: 0 }
    return computeContextUsageDisplay(usage, contextProjection?.contextWindow.tokens ?? maximumContext, effectiveOutputMax, {
      thinkingTokensToExclude
    })
  }, [hasData, lastUsage, contextProjection, maximumContext, effectiveOutputMax, thinkingTokensToExclude])

  const circumference = 2 * Math.PI * RADIUS

  const segments = useMemo(() => {
    if (!display) return []
    return buildContextRingSegments(display.usedRatio, display.reservedRatio, circumference)
  }, [display, circumference])

  // 口径 B 构成（P2，§6.7）：取本会话最近一条带归因的 step 行（block-v1 落库），
  // 按三源权重归一化到「上轮输入」（totalRequestInput，精确三档和，AD17），
  // 恒等式 Σ构成段 == totalRequestInput 精确成立（AT15）。
  const [latestAttribution, setLatestAttribution] = useState<LatestStepAttribution | null>(null)
  useEffect(() => {
    if (!sessionId) {
      setLatestAttribution(null)
      return
    }
    let cancelled = false
    window.api
      ?.usageStatsLatestSessionAttribution?.(sessionId)
      .then((row) => {
        if (!cancelled) setLatestAttribution(row)
      })
      .catch(() => {
        if (!cancelled) setLatestAttribution(null)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, display?.totalRequestInput])

  const composition = useMemo(() => {
    if (!display || !latestAttribution?.estimatorVersion) return null
    const weights = [latestAttribution.systemTokens ?? 0, latestAttribution.toolsTokens ?? 0, latestAttribution.messageTokens ?? 0]
    if (weights.every((w) => w <= 0)) return null
    const normalized = normalizeTokensLargestRemainder(weights, display.totalRequestInput)
    return { version: latestAttribution.estimatorVersion, system: normalized[0]!, tools: normalized[1]!, messages: normalized[2]! }
  }, [display, latestAttribution])

  const tooltipTitle = useMemo(() => {
    if (!hasData || !display) {
      if (pendingImageTokens > 0 || historyImageTokens > 0) {
        const lines: string[] = []
        if (pendingImageTokens > 0) {
          lines.push(t('tooltip.pendingImages', { count: pendingImageTokens }))
        }
        if (historyImageTokens > 0) {
          lines.push(t('tooltip.historyImages', { count: historyImageTokens }))
        }
        return (
          <div className="context-usage-tooltip">
            {lines.map((line, index) => (
              <div key={index}>{line}</div>
            ))}
          </div>
        )
      }
      return t('tooltip.noData')
    }

    // 分组结构（AD21）：占用 / 构成 / 缓存 / 预留；总计与图例不归组。
    // 约束：既有文案字符串一个不改；空组连标题一起隐藏；usedRatio 与环形不受影响。
    const locale = i18n.language
    const occupationLines: string[] = []
    occupationLines.push(`${t('tooltip.estimatedOccupancy')}　${formatNum(display.estimatedOccupancy, locale)}`)
    occupationLines.push(`${t('tooltip.lastRequestInput')}　${formatNum(display.totalRequestInput, locale)}`)
    if (display.lastOutput > 0) {
      occupationLines.push(`${t('tooltip.lastOutput')}　${formatNum(display.lastOutput, locale)}`)
    }
    if (thinkingTokensToExclude > 0) {
      occupationLines.push(t('tooltip.thinkingExcluded', { count: formatNum(thinkingTokensToExclude, locale) }))
    }
    if (pendingImageTokens > 0) {
      occupationLines.push(t('tooltip.pendingImages', { count: pendingImageTokens }))
    }
    if (historyImageTokens > 0) {
      occupationLines.push(t('tooltip.historyImages', { count: historyImageTokens }))
    }

    const cacheRead = lastUsage?.cache_read_input_tokens ?? 0
    const cacheWrite = lastUsage?.cache_creation_input_tokens ?? 0

    const renderGroup = (title: string, lines: string[], key: string, muted = true) => (
      <div key={key} className="context-usage-tooltip-group">
        {muted && (
          <div style={{ opacity: 0.65, marginTop: 4 }} data-testid={`usage-tooltip-group-${key}`}>
            {title}
          </div>
        )}
        {lines.map((line, index) => (
          <div key={index}>{line}</div>
        ))}
      </div>
    )

    const compositionLines: string[] = []
    if (composition) {
      compositionLines.push(t('composition.estimatedMark', { count: formatNum(composition.system, locale), version: composition.version }) + ` · ${t('composition.systemPrompt')}`)
      compositionLines.push(t('composition.estimatedMark', { count: formatNum(composition.tools, locale), version: composition.version }) + ` · ${t('composition.tools')}`)
      compositionLines.push(t('composition.estimatedMark', { count: formatNum(composition.messages, locale), version: composition.version }) + ` · ${t('composition.messages')}`)
    }

    const cacheLines: string[] = []
    if (cacheRead > 0) cacheLines.push(`${t('tooltip.cacheRead')}　${formatNum(cacheRead, locale)}`)
    if (cacheWrite > 0) cacheLines.push(`${t('tooltip.cacheWrite')}　${formatNum(cacheWrite, locale)}`)

    return (
      <div className="context-usage-tooltip">
        {renderGroup(t('groups.occupation'), occupationLines, 'occupation')}
        {compositionLines.length > 0 && renderGroup(t('groups.composition'), compositionLines, 'composition')}
        {cacheLines.length > 0 && renderGroup(t('groups.cache'), cacheLines, 'cache')}
        {renderGroup(t('groups.reserve'), [`${t('tooltip.outputReserve')}　${formatNum(display.effectiveOutputMax, locale)}`], 'reserve')}
        <div>{t('tooltip.separator')}</div>
        <div>
          {t('tooltip.total')} {formatNum(display.estimatedOccupancy, locale)} / {formatNum(display.maximumContext, locale)}（{display.percentUsed.toFixed(1)}%）
        </div>
        <div>{`${t('tooltip.legend')}　　■ ${t('tooltip.legendUsed')}　■ ${t('tooltip.legendReserved')}　□ ${t('tooltip.legendFree')}`}</div>
      </div>
    )
  }, [hasData, lastUsage, display, pendingImageTokens, historyImageTokens, thinkingTokensToExclude, composition, t, i18n.language])

  const ariaLabel =
    hasData && display
      ? t('aria.hasData', { percent: display.percentUsed.toFixed(1) })
      : t('aria.noData')

  return (
    <Tooltip title={tooltipTitle} placement="top" classNames={{ root: 'context-usage-tooltip-overlay' }}>
      <span
        className="context-usage-ring"
        style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}
        aria-label={ariaLabel}
      >
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden>
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="var(--sa-context-ring-track)"
            strokeWidth={STROKE_WIDTH}
          />
          {segments.map((seg, i) => (
            <circle
              key={i}
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke={seg.color}
              strokeWidth={STROKE_WIDTH}
              strokeDasharray={`${seg.dashLen} ${circumference - seg.dashLen}`}
              strokeDashoffset={seg.dashOffset}
              strokeLinecap="butt"
              transform={`rotate(-90 ${CENTER} ${CENTER})`}
            />
          ))}
        </svg>
      </span>
    </Tooltip>
  )
}
