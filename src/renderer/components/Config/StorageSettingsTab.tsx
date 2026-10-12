import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Descriptions, Progress, Skeleton, Space, Tag, Typography } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { StorageAudit, StorageMaintenanceProgress, StorageOverview } from '../../../shared/storageTypes'

type AuditState = 'idle' | 'pending' | 'complete' | 'partial' | 'failed'

function formatBytes(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatCount(value: number | null | undefined): string { return value == null ? '—' : new Intl.NumberFormat().format(value) }

export function StorageSettingsTab() {
  const { t } = useTypedTranslation('config')
  const translate = useRef(t)
  translate.current = t
  const { message } = App.useApp()
  const [overview, setOverview] = useState<StorageOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditState, setAuditState] = useState<AuditState>('idle')
  const [audit, setAudit] = useState<StorageAudit | null>(null)
  const [progress, setProgress] = useState<StorageMaintenanceProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [auditError, setAuditError] = useState<string | null>(null)
  const mounted = useRef(false)
  const overviewRequest = useRef(0)
  const auditRequest = useRef(0)

  const loadOverview = useCallback(async (force = false) => {
    const request = ++overviewRequest.current
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.storageGetOverview(force)
      if (mounted.current && request === overviewRequest.current) setOverview(result)
    } catch {
      if (mounted.current && request === overviewRequest.current) setError(translate.current('storage.loadFailed'))
    } finally {
      if (mounted.current && request === overviewRequest.current) setLoading(false)
    }
  }, [])

  const loadAudit = useCallback(async () => {
    const request = ++auditRequest.current
    setAuditLoading(true)
    setAuditState('pending')
    setAuditError(null)
    try {
      const result = await window.api.storageRunAudit()
      if (mounted.current && request === auditRequest.current) {
        setAudit(result)
        setAuditState(result.status === 'complete' ? 'complete' : result.status === 'failed' ? 'failed' : 'partial')
      }
    } catch {
      if (mounted.current && request === auditRequest.current) {
        setAuditState('failed')
        setAuditError(translate.current('storage.auditFailed'))
      }
    } finally {
      if (mounted.current && request === auditRequest.current) setAuditLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void loadOverview()
    return () => {
      mounted.current = false
      overviewRequest.current += 1
      auditRequest.current += 1
    }
  }, [loadOverview])
  useEffect(() => window.api.storageOnMaintenanceProgress(setProgress), [])

  const clearCache = async () => {
    try {
      const result = await window.api.storageClearCache()
      message.success(t('storage.clearSuccess', { count: result.cacheRows + result.eligibilityRows }))
      await loadOverview(true)
    } catch { message.error(t('storage.operationFailed')) }
  }
  const compact = async () => {
    setProgress({ phase: 'archive' })
    setError(null)
    try {
      const result = await window.api.storageCompact()
      setProgress({ phase: 'complete' })
      message.success(t('storage.compactSuccess', { before: formatBytes(result.bytesBefore), after: formatBytes(result.bytesAfter) }))
      await loadOverview(true)
    } catch (reason) {
      setProgress(null)
      if (reason instanceof Error && reason.message.includes('STORAGE_MAINTENANCE_BUSY')) setError(t('storage.busy'))
      else setError(t('storage.operationFailed'))
    }
  }

  const auditStatusLabel = ({ idle: 'storage.auditNotRun', pending: 'storage.auditPending', complete: 'storage.auditComplete',
    partial: 'storage.auditPartial', failed: 'storage.auditFailed' } as const)[auditState]
  const collectedAt = overview ? new Date(overview.collectedAt).toLocaleString() : null
  const hasPartialOverview = overview?.status === 'partial' || overview?.status === 'failed'
  return <section aria-labelledby="storage-settings-title">
    <Typography.Title level={4} id="storage-settings-title">{t('storage.title')}</Typography.Title>
    <Typography.Paragraph>{t('storage.description')}</Typography.Paragraph>
    {error ? <Alert type="error" showIcon message={error} /> : null}
    {hasPartialOverview ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('storage.overviewPartial')} /> : null}
    {loading && !overview ? <Skeleton active paragraph={{ rows: 5 }} /> : <>
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label={t('storage.database')}>{formatBytes(overview?.database.dbBytes)}</Descriptions.Item>
        <Descriptions.Item label={t('storage.databaseSidecars')}>
          {formatBytes(overview?.database.walBytes != null && overview.database.shmBytes != null
            ? overview.database.walBytes + overview.database.shmBytes : null)}
        </Descriptions.Item>
        <Descriptions.Item label={t('storage.total')}>{formatBytes(overview?.totalBytes)}</Descriptions.Item>
        <Descriptions.Item label={t('storage.messages')}>{formatBytes(overview?.tables.messages?.textBytes)}</Descriptions.Item>
        <Descriptions.Item label={t('storage.sourceSpill')}>{formatBytes(overview?.spill.sourceOfTruthBytes)}</Descriptions.Item>
        <Descriptions.Item label={t('storage.pendingSourceSpill')}>{formatBytes(overview?.pendingGc.bytes)}</Descriptions.Item>
        <Descriptions.Item label={t('storage.degradableSpill')}>
          {overview?.spill.classification === 'unknown' ? t('storage.classificationUnknown') : formatBytes(overview?.spill.degradableBytes)}
        </Descriptions.Item>
        <Descriptions.Item label={t('storage.orphanSpill')}>
          {overview?.spill.classification === 'unknown' ? t('storage.classificationUnknown') : formatBytes(overview?.spill.orphanBytes)}
        </Descriptions.Item>
        <Descriptions.Item label={t('storage.degradedSpill')}>
          {formatBytes(overview?.spillDegraded.totalBytes)}
        </Descriptions.Item>
        <Descriptions.Item label={t('storage.spillObserved')}>{formatBytes(overview?.spill.observedBytes)}</Descriptions.Item>
        <Descriptions.Item label={t('storage.collectedAt')}>{collectedAt ?? '—'}</Descriptions.Item>
      </Descriptions>
      {overview?.spill.classification === 'unknown' ? <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
        {t('storage.classificationUnknown')}
      </Typography.Text> : null}
    </>}

    <section aria-labelledby="storage-audit-title" style={{ marginTop: 20 }}>
      <Space align="center" wrap>
        <Typography.Title level={5} id="storage-audit-title" style={{ margin: 0 }}>{t('storage.auditTitle')}</Typography.Title>
        <Tag color={auditState === 'complete' ? 'success' : auditState === 'failed' || auditState === 'partial' ? 'warning' : 'default'}>
          {t(auditStatusLabel)}
        </Tag>
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 8 }}>{t('storage.auditDescription')}</Typography.Paragraph>
      {auditError ? <Alert type="error" showIcon message={auditError} style={{ marginBottom: 8 }} /> : null}
      {auditState === 'partial' && (audit?.errorCodes.length ?? 0) > 0 ? <Alert type="warning" showIcon style={{ marginBottom: 8 }}
        message={t('storage.auditPartial')} description={`${t('storage.auditErrorCodes')}: ${audit!.errorCodes.join(', ')}`} /> : null}
      {audit ? <Descriptions column={1} size="small" bordered style={{ marginBottom: 8 }}>
        <Descriptions.Item label={t('storage.auditEventRows')}>{formatCount(audit.canonicalRequiredData?.eventRows ?? null)}</Descriptions.Item>
        <Descriptions.Item label={t('storage.auditSpillReferences')}>
          {audit.strictSpillReferences?.descriptors == null ? '—' : audit.strictSpillReferences.descriptors}
        </Descriptions.Item>
        <Descriptions.Item label={t('storage.auditCollectedAt')}>{new Date(audit.collectedAt).toLocaleString()}</Descriptions.Item>
      </Descriptions> : null}
      <Button loading={auditLoading} onClick={() => void loadAudit()}>{t('storage.runAudit')}</Button>
    </section>

    <Space wrap style={{ marginTop: 20 }}>
      <Button loading={loading} onClick={() => void loadOverview(true)}>{t('storage.refresh')}</Button>
      <Button onClick={() => void clearCache()}>{t('storage.clearCache')}</Button>
      <Button type="primary" loading={progress !== null && progress.phase !== 'complete'} onClick={() => void compact()}>{t('storage.compact')}</Button>
    </Space>
    {progress ? <div style={{ marginTop: 16 }} aria-live="polite">
      <Typography.Text>{t(`storage.phase.${progress.phase}`)}</Typography.Text>
      <Progress percent={progress.phase === 'complete' ? 100 : progress.phase === 'archive' ? 20 : progress.phase === 'vacuum' ? 55 : 80} status={progress.phase === 'complete' ? 'success' : 'active'} />
    </div> : null}
  </section>
}
