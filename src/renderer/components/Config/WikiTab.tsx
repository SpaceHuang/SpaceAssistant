import { App, Button, Input, InputNumber, Modal, Space, Switch, Tag, Typography } from 'antd'
import { useState } from 'react'
import type { WikiConfig, WikiMigrationState } from '../../../shared/domainTypes'
import { ConfigField, ConfigSettingsStack, ConfigSwitchRow } from './ConfigField'
import { formatUserFacingError } from '../../utils/formatUserFacingError'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { WIKI_VOCABULARY_PREFIX } from '../../../shared/wikiConstants'

type Props = {
  wiki: WikiConfig
  onChange: (next: WikiConfig) => void
}

type MigrationStatus = {
  pendingLegacyMigration?: boolean
  legacyRoots?: string[]
  migration?: WikiMigrationState
}

/** T2.6：共享库设置页——受控改名 / 迁移入口与报告查看（数据源 config.wiki.migration）/ 打开目录。 */
export function WikiTab({ wiki, onChange }: Props) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('config')
  const [renaming, setRenaming] = useState(false)
  const [newRootPath, setNewRootPath] = useState('')
  const [migration, setMigration] = useState<MigrationStatus | null>(null)

  const initWiki = async () => {
    const result = await window.api.wikiInit({ installSkill: true })
    if (!result.ok) {
      message.error(formatUserFacingError(result.error))
      return
    }
    message.success(
      t('wiki.initSuccess', {
        path: result.rootPath,
        skillSuffix: result.skillInstalled ? t('wiki.skillInstalledSuffix') : ''
      })
    )
    await window.api.skillInvalidateCache()
  }

  const startRename = async () => {
    // P1-16（§11）：存量自定义根未迁移时先展示迁移引导而非直接改名
    const status = (await window.api.wikiMigrationStatus()) as unknown as MigrationStatus
    if (status.pendingLegacyMigration) {
      message.warning(t('wiki.renameBlockedByMigration'))
      void openMigrationInfo()
      return
    }
    setNewRootPath(wiki.rootPath)
    setRenaming(true)
  }

  const confirmRename = async () => {
    const result = await window.api.wikiRenameRoot({ newRootPath: newRootPath.trim() })
    if (!result.ok) {
      // 失败回滚语义：配置值保持不变，仅提示错误
      message.error(formatUserFacingError(result.error))
      return
    }
    onChange({ ...wiki, rootPath: newRootPath.trim() })
    setRenaming(false)
    message.success(t('wiki.renameSuccess', { path: newRootPath.trim() }))
  }

  const openMigrationInfo = async () => {
    const status = (await window.api.wikiMigrationStatus()) as unknown as MigrationStatus
    setMigration(status)
  }

  // BLK-1：设置页弹窗内直接执行迁移（§16-B5 迁移入口必须可达）
  const [migrating, setMigrating] = useState(false)
  const runMigration = async () => {
    setMigrating(true)
    try {
      const report = await window.api.wikiMigrateLegacy()
      const status = (await window.api.wikiMigrationStatus()) as unknown as MigrationStatus
      setMigration({ ...status, migration: { ...(status.migration ?? { status: 'completed' }), report } })
    } catch (e) {
      message.error(formatUserFacingError(e instanceof Error ? e.message : String(e)))
    } finally {
      setMigrating(false)
    }
  }

  const openSharedDir = () => {
    // BLK-4（D9）：挂载按词汇前缀解析，rootPath 是物理目录名不参与词汇语义
    void window.api.fileShowInExplorer(WIKI_VOCABULARY_PREFIX)
  }

  const report = migration?.migration?.report

  return (
    <ConfigSettingsStack>
      <ConfigSwitchRow
        label={t('wiki.enableLabel')}
        checked={wiki.enabled}
        onChange={(enabled) => onChange({ ...wiki, enabled })}
      />
      <ConfigField label={t('wiki.rootPathLabel')} hint={t('wiki.rootPathHelp')}>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={wiki.rootPath}
            readOnly
            placeholder={t('wiki.rootPathPlaceholder')}
          />
          <Button onClick={() => void startRename()} disabled={!wiki.enabled}>
            {t('wiki.renameButton')}
          </Button>
        </Space.Compact>
      </ConfigField>
      <ConfigSwitchRow
        label={t('wiki.hideFromTreeLabel')}
        checked={wiki.hideWikiFromFileTree}
        onChange={(hideWikiFromFileTree) => onChange({ ...wiki, hideWikiFromFileTree })}
      />
      <ConfigSwitchRow
        label={t('wiki.interactiveIngestLabel')}
        checked={wiki.interactiveIngest}
        onChange={(interactiveIngest) => onChange({ ...wiki, interactiveIngest })}
      />
      <ConfigField label={t('wiki.maxBatchIngestLabel')}>
        <InputNumber
          min={1}
          max={50}
          value={wiki.maxBatchIngest}
          onChange={(v) => onChange({ ...wiki, maxBatchIngest: v ?? 10 })}
          style={{ width: '100%' }}
        />
      </ConfigField>
      <Space wrap>
        <Button type="primary" onClick={() => void initWiki()} disabled={!wiki.enabled}>
          {t('wiki.initButton')}
        </Button>
        <Button onClick={() => void openMigrationInfo()} disabled={!wiki.enabled}>
          {t('wiki.migrationEntry')}
        </Button>
        <Button onClick={openSharedDir} disabled={!wiki.enabled}>
          {t('wiki.openSharedDir')}
        </Button>
      </Space>
      <Modal
        open={renaming}
        title={t('wiki.renameTitle')}
        onOk={() => void confirmRename()}
        onCancel={() => setRenaming(false)}
        okText={t('wiki.renameButton')}
      >
        <Typography.Paragraph type="secondary">{t('wiki.renameHint')}</Typography.Paragraph>
        <Input
          value={newRootPath}
          onChange={(e) => setNewRootPath(e.target.value.trim())}
          placeholder={t('wiki.rootPathPlaceholder')}
        />
      </Modal>
      <Modal
        open={migration !== null}
        title={t('wiki.migrationTitle')}
        footer={null}
        onCancel={() => setMigration(null)}
        width={560}
      >
        {migration?.pendingLegacyMigration ? (
          <>
            <Typography.Paragraph>
              {t('wiki.migrationPendingHint', { count: migration.legacyRoots?.length ?? 0 })}
              {migration.legacyRoots?.map((r) => (
                <Tag key={r}>{r}</Tag>
              ))}
            </Typography.Paragraph>
            <Button type="primary" loading={migrating} onClick={() => void runMigration()}>
              {t('wiki.migrationRunNow')}
            </Button>
          </>
        ) : (
          <Typography.Paragraph type="secondary">{t('wiki.migrationUpToDate')}</Typography.Paragraph>
        )}
        {report ? (
          <>
            <Typography.Title level={5}>{t('wiki.migrationReportTitle')}</Typography.Title>
            <Typography.Paragraph>
              {t('wiki.migrationReportSummary', {
                migrated: report.profiles?.filter((p) => p.status === 'migrated').length ?? 0,
                conflicts: report.conflicts?.length ?? 0,
                renames: report.renames?.length ?? 0
              })}
            </Typography.Paragraph>
            {(report.conflicts?.length ?? 0) > 0 && (
              <>
                <Typography.Title level={5}>{t('wiki.migrationConflictsTitle')}</Typography.Title>
                {report.conflicts!.map((c) => (
                  <Typography.Paragraph key={`${c.path}-${c.keptAs}`} style={{ marginBottom: 4 }}>
                    <code>{c.path}</code> → <code>{c.keptAs}</code>
                  </Typography.Paragraph>
                ))}
              </>
            )}
          </>
        ) : (
          <Typography.Paragraph type="secondary">{t('wiki.migrationNoReport')}</Typography.Paragraph>
        )}
      </Modal>
    </ConfigSettingsStack>
  )
}
