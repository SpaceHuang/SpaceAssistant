import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Descriptions, Progress, Space, Typography } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { StorageMaintenanceProgress } from '../../../shared/storageTypes'

type StorageProfile = {
  dbBytes?: number
  totalBytes?: number
  databaseFiles?: { walBytes?: number; shmBytes?: number; totalBytes?: number }
  spillDegraded?: { totalBytes?: number }
  spillFiles?: { totalBytes?: number; sourceOfTruthBytes?: number; degradableBytes?: number; orphanBytes?: number }
  sourceTruthGc?: { pendingFiles?: number; pendingBytes?: number; orphanBytes?: number; scanStatus?: string }
  tables?: Record<string, { textBytes?: number } | null>
}

function formatBytes(value = 0): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function StorageSettingsTab() {
  const { t } = useTypedTranslation('config')
  const { message } = App.useApp()
  const [profile, setProfile] = useState<StorageProfile | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<StorageMaintenanceProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try { setProfile(await window.api.storageGetProfile() as StorageProfile) }
    catch { setError(t('storage.loadFailed')) }
    finally { setLoading(false) }
  }, [t])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => window.api.storageOnMaintenanceProgress(setProgress), [])

  const clearCache = async () => {
    try {
      const result = await window.api.storageClearCache()
      message.success(t('storage.clearSuccess', { count: result.cacheRows + result.eligibilityRows }))
      await refresh()
    } catch { message.error(t('storage.operationFailed')) }
  }
  const compact = async () => {
    setProgress({ phase: 'archive' })
    setError(null)
    try {
      const result = await window.api.storageCompact()
      setProgress({ phase: 'complete' })
      message.success(t('storage.compactSuccess', { before: formatBytes(result.bytesBefore), after: formatBytes(result.bytesAfter) }))
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error && reason.message.includes('STORAGE_MAINTENANCE_BUSY') ? t('storage.busy') : t('storage.operationFailed'))
    }
  }

  const bytes = (table: string) => profile?.tables?.[table]?.textBytes ?? 0
  return <section aria-labelledby="storage-settings-title">
    <Typography.Title level={4} id="storage-settings-title">{t('storage.title')}</Typography.Title>
    <Typography.Paragraph>{t('storage.description')}</Typography.Paragraph>
    {error ? <Alert type="error" showIcon message={error} /> : null}
    <Descriptions column={1} size="small" bordered>
      <Descriptions.Item label={t('storage.database')}>{formatBytes(profile?.dbBytes)}</Descriptions.Item>
      <Descriptions.Item label={t('storage.databaseSidecars')}>{formatBytes((profile?.databaseFiles?.walBytes ?? 0) + (profile?.databaseFiles?.shmBytes ?? 0))}</Descriptions.Item>
      <Descriptions.Item label={t('storage.total')}>{formatBytes(profile?.totalBytes)}</Descriptions.Item>
      <Descriptions.Item label={t('storage.messages')}>{formatBytes(bytes('messages'))}</Descriptions.Item>
      <Descriptions.Item label={t('storage.canonicalHistory')}>{formatBytes(bytes('canonicalHistory'))}</Descriptions.Item>
      <Descriptions.Item label={t('storage.transcriptSnapshots')}>{formatBytes(bytes('transcriptSnapshots'))}</Descriptions.Item>
      <Descriptions.Item label={t('storage.sourceSpill')}>{formatBytes(profile?.spillFiles?.sourceOfTruthBytes)}</Descriptions.Item>
      <Descriptions.Item label={t('storage.pendingSourceSpill')}>{formatBytes(profile?.sourceTruthGc?.pendingBytes)}</Descriptions.Item>
      <Descriptions.Item label={t('storage.degradableSpill')}>{formatBytes(profile?.spillDegraded?.totalBytes ?? profile?.spillFiles?.degradableBytes)}</Descriptions.Item>
      <Descriptions.Item label={t('storage.orphanSpill')}>{formatBytes(profile?.spillFiles?.orphanBytes)}</Descriptions.Item>
    </Descriptions>
    <Space wrap style={{ marginTop: 20 }}>
      <Button loading={loading} onClick={() => void refresh()}>{t('storage.refresh')}</Button>
      <Button onClick={() => void clearCache()}>{t('storage.clearCache')}</Button>
      <Button type="primary" loading={progress !== null && progress.phase !== 'complete'} onClick={() => void compact()}>{t('storage.compact')}</Button>
    </Space>
    {progress ? <div style={{ marginTop: 16 }} aria-live="polite">
      <Typography.Text>{t(`storage.phase.${progress.phase}`)}</Typography.Text>
      <Progress percent={progress.phase === 'complete' ? 100 : progress.phase === 'archive' ? 20 : progress.phase === 'vacuum' ? 55 : 80} status={progress.phase === 'complete' ? 'success' : 'active'} />
    </div> : null}
  </section>
}
