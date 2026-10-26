import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Alert, App, Button, Input, Modal, Tooltip, Typography } from 'antd'
import { FileTree, type FileTreeHandle } from '../FileTree/FileTree'
import { isUnderWikiRoot, subscribeFilePaneSelect } from '../../services/filePaneNavigation'
import { formatUserFacingError } from '../../utils/formatUserFacingError'
import { projectDisplayMap, summarizeMigrationReport } from './wikiMigrationUi'
import { LegacyRootChips, MigrationConflictSection, MigrationFailureSection, MigrationSummary } from './wikiMigrationShared'
import type { WikiMigrationReport } from '../../../shared/domainTypes'
import type { WikiBootstrapMigrationPreview } from '../../../shared/domainTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import './wikiPane.css'
import { WIKI_VOCABULARY_PREFIX } from '../../../shared/wikiConstants'

export type WikiPaneHandle = {
  refresh: () => void
  openInExplorer: () => void
}

type Props = {
  workDir: string
  onFileSelect: (relPath: string) => void
  onSwitchToWikiTab: () => void
  onCollectToWiki?: (relPath: string) => void
  onInitStateChange?: (initialized: boolean | null) => void
}

export const WikiPane = forwardRef<WikiPaneHandle, Props>(function WikiPane(
  { workDir, onFileSelect, onSwitchToWikiTab, onCollectToWiki, onInitStateChange },
  ref
) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('wiki')
  const wikiRoot = WIKI_VOCABULARY_PREFIX // BLK-4（D9）：词汇根恒为常量

  const [wikiInitialized, setWikiInitialized] = useState<boolean | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const wikiTreeRef = useRef<FileTreeHandle>(null)
  // T2.5：迁移提示条 / 向导 / 项目显示名数据源（wiki:status.projects，v1.12）
  const [pendingMigration, setPendingMigration] = useState<{ legacyRoots: string[] } | null>(null)
  // P1-14：向导开关独立 state——检测命中只出横幅，点「迁移」才弹向导
  const [wizardOpen, setWizardOpen] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [extraRootsInput, setExtraRootsInput] = useState('')
  const [migrationReport, setMigrationReport] = useState<WikiMigrationReport | null>(null)
  const [projectNames, setProjectNames] = useState<ReturnType<typeof projectDisplayMap>>(new Map())
  const [domainLifecycle, setDomainLifecycle] = useState<import('../../../shared/domainTypes').WikiStatus['domainLifecycle']>()
  const [domainPreview, setDomainPreview] = useState<WikiBootstrapMigrationPreview | null>(null)
  const [domainMigrationBusy, setDomainMigrationBusy] = useState(false)
  const [domainMigrationComplete, setDomainMigrationComplete] = useState(false)

  const wikiIndexPath = `${wikiRoot}/wiki/index.md`
  const highlightPaths = useMemo(() => [wikiIndexPath], [wikiIndexPath])

  const refreshWikiStatus = useCallback(async () => {
    const status = (await window.api.wikiStatus()) as import('../../../shared/domainTypes').WikiStatus
    setWikiInitialized(status.initialized)
    setDomainLifecycle(status.domainLifecycle)
    setPendingMigration(
      status.pendingLegacyMigration ? { legacyRoots: status.legacyRoots ?? [] } : null
    )
    setProjectNames(projectDisplayMap(status.projects))
  }, [wikiRoot])

  useEffect(() => {
    onInitStateChange?.(wikiInitialized)
  }, [wikiInitialized, onInitStateChange])

  useImperativeHandle(
    ref,
    () => ({
      refresh: () => {
        void wikiTreeRef.current?.refresh()
      },
      openInExplorer: () => {
        void window.api.fileShowInExplorer(wikiRoot)
      }
    }),
    [wikiRoot]
  )

  useEffect(() => {
    void refreshWikiStatus()
  }, [refreshWikiStatus, wikiRoot])

  useEffect(() => {
    return subscribeFilePaneSelect((req) => {
      const preferWiki = req.preferWiki ?? isUnderWikiRoot(req.relPath, wikiRoot)
      if (!preferWiki) {
        setSelectedKey(null)
        return
      }
      onSwitchToWikiTab()
      void wikiTreeRef.current?.selectPath(req.relPath)
      setSelectedKey(req.relPath.replace(/\\/g, '/'))
    })
  }, [wikiRoot, onSwitchToWikiTab])

  const handleWikiSelect = (relPath: string) => {
    setSelectedKey(relPath)
    onFileSelect(relPath)
  }

  const runMigration = async () => {
    setMigrating(true)
    try {
      const extraLegacyRoots = extraRootsInput
        .split(/[,;，；]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .map((rootDirName) => ({ workDir, rootDirName }))
      const report = await window.api.wikiMigrateLegacy({ extraLegacyRoots: extraLegacyRoots.length ? extraLegacyRoots : undefined })
      setMigrationReport(report)
      // 向导立即退役：即使迁移未彻底完成（refreshWikiStatus 重新检出 pending），关闭报告后也不得弹回向导
      setWizardOpen(false)
      setPendingMigration(null)
      await refreshWikiStatus()
      void wikiTreeRef.current?.refresh()
    } catch (e) {
      message.error(formatUserFacingError(e instanceof Error ? e.message : String(e)))
    } finally {
      setMigrating(false)
    }
  }

  const initWiki = async () => {
    const result = await window.api.wikiInit({ installSkill: true })
    if (!result.ok) {
      message.error(formatUserFacingError(result.error))
      return
    }
    message.success(t('initSuccess'))
    await window.api.skillInvalidateCache()
    await refreshWikiStatus()
    void wikiTreeRef.current?.refresh()
  }

  const reviewDomainMigration = async () => {
    setDomainMigrationBusy(true)
    try {
      const preview = await window.api.wikiDomainMigrationPreview()
      setDomainPreview(preview)
    } catch (e) {
      message.error(formatUserFacingError(e instanceof Error ? e.message : String(e)))
    } finally {
      setDomainMigrationBusy(false)
    }
  }

  const applyDomainMigration = async () => {
    if (!domainPreview) return
    setDomainMigrationBusy(true)
    try {
      const result = await window.api.wikiDomainMigrationApply({ manifestHash: domainPreview.manifestHash })
      setDomainPreview(null)
      if (result.status === 'completed') {
        setDomainMigrationComplete(true)
        await refreshWikiStatus()
        void wikiTreeRef.current?.refresh()
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      if (error.includes('preflight-stale')) {
        setDomainPreview(null)
        message.warning(t('domainMigration.staleReview'))
      } else {
        message.error(formatUserFacingError(error))
      }
      await refreshWikiStatus()
    } finally {
      setDomainMigrationBusy(false)
    }
  }

  return (
    <div className="wiki-pane">
      <div className="wiki-pane-body">
        {domainLifecycle === 'initializing' && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            message={t('domainMigration.pending')}
            action={<Button size="small" type="primary" loading={domainMigrationBusy} onClick={() => void reviewDomainMigration()}>{t('domainMigration.review')}</Button>}
          />
        )}
        {domainLifecycle === 'recovery_required' && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={t('domainMigration.recoveryRequired')} />}
        {domainLifecycle === 'domain_enabled' && <Alert type="info" showIcon style={{ marginBottom: 8 }} message={t('domainEnabledNotice')} />}
        {domainMigrationComplete && <Alert type="success" showIcon style={{ marginBottom: 8 }} message={t('domainMigration.complete')} />}
        {pendingMigration && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            message={t('migration.banner', { count: pendingMigration.legacyRoots.length })}
            action={
              // 迁移是「永不自动删除」的安全操作：品牌橙主按钮引导前进，danger 只留给真破坏性动作
              <Button size="small" type="primary" onClick={() => setWizardOpen(true)}>
                {t('migration.openWizard')}
              </Button>
            }
          />
        )}
        {projectNames.size > 0 && (
          <div className="wiki-migration-chips wiki-migration-chips-pane">
            {[...projectNames.entries()].map(([projectId, info]) => (
              <Tooltip key={projectId} title={info.workDir}>
                <span className={info.orphan ? 'wiki-migration-chip wiki-migration-chip-orphan' : 'wiki-migration-chip'}>
                  {info.displayName}
                  {info.orphan ? ` ${t('migration.orphanSuffix')}` : ''}
                </span>
              </Tooltip>
            ))}
          </div>
        )}
        {(window as Window & { api?: { wikiStatus: () => Promise<import('../../../shared/domainTypes').WikiStatus> } }).api && null}
        {wikiInitialized === false ? (
          <div className="wiki-pane-empty">
            <p className="wiki-pane-empty-title">{t('empty.title')}</p>
            <p className="wiki-pane-empty-desc">{t('empty.desc')}</p>
            <Button type="primary" size="small" className="wiki-pane-init-btn" onClick={() => void initWiki()}>
              {t('empty.initButton')}
            </Button>
          </div>
        ) : (
          <FileTree
            ref={wikiTreeRef}
            embedded
            workDir={workDir}
            selectedKey={selectedKey}
            onSelectedKeyChange={setSelectedKey}
            onFileSelect={handleWikiSelect}
            highlightRelPaths={highlightPaths}
            wikiRootPath={wikiRoot}
            onCollectToWiki={onCollectToWiki}
            treeOptions={{
              rootRelPath: wikiRoot,
              rootDisplayName: wikiRoot.split('/').pop() || WIKI_VOCABULARY_PREFIX,
              readOnly: true
            }}
          />
        )}
      </div>
      <Modal
        open={pendingMigration !== null && wizardOpen && migrationReport === null}
        title={t('migration.wizardTitle')}
        confirmLoading={migrating}
        onOk={() => void runMigration()}
        onCancel={() => setWizardOpen(false)}
        okText={t('migration.runNow')}
        cancelText={t('migration.later')}
      >
        <Typography.Paragraph>{t('migration.wizardDesc', { count: pendingMigration?.legacyRoots.length ?? 0 })}</Typography.Paragraph>
        <LegacyRootChips roots={pendingMigration?.legacyRoots ?? []} />
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 8 }}>
          {t('migration.extraRootsHint')}
        </Typography.Paragraph>
        <Input
          value={extraRootsInput}
          onChange={(e) => setExtraRootsInput(e.target.value)}
          placeholder={t('migration.extraRootsPlaceholder')}
        />
      </Modal>
      <Modal
        open={domainPreview !== null}
        title={t('domainMigration.title')}
        confirmLoading={domainMigrationBusy}
        onOk={() => void applyDomainMigration()}
        onCancel={() => { if (!domainMigrationBusy) setDomainPreview(null) }}
        okText={t('domainMigration.confirm')}
        cancelText={t('domainMigration.cancel')}
        okButtonProps={{ disabled: Boolean(domainPreview?.diagnostics.length) }}
        cancelButtonProps={{ disabled: domainMigrationBusy }}
        closable={!domainMigrationBusy}
        maskClosable={!domainMigrationBusy}
        width={680}
      >
        {domainPreview && (
          <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: 8 }}>
            <Typography.Paragraph>{t('domainMigration.summary', { files: domainPreview.files.length, changes: domainPreview.changes.length })}</Typography.Paragraph>
            {domainPreview.resumeRequired && <Alert type="info" showIcon message={t('domainMigration.resume')} style={{ marginBottom: 12 }} />}
            {domainPreview.files.length > 0 && <><Typography.Text strong>{t('domainMigration.files')}</Typography.Text><ul>{domainPreview.files.map(file => <li key={`${file.path}:${file.sha256}`} style={{ overflowWrap: 'anywhere' }}>{file.path} <Typography.Text type="secondary">({file.kind})</Typography.Text></li>)}</ul></>}
            {domainPreview.changes.length > 0 && <><Typography.Text strong>{t('domainMigration.changes')}</Typography.Text><ul>{domainPreview.changes.map(change => <li key={change.relativePath} style={{ overflowWrap: 'anywhere' }}>{change.relativePath}: {change.oldHash || t('domainMigration.newFile')} → {change.newHash}</li>)}</ul></>}
            {domainPreview.review.categories.length > 0 && <><Typography.Text strong>{t('domainMigration.categories')}</Typography.Text><ul>{domainPreview.review.categories.map(category => <li key={category.categoryId}>{category.legacyName} → {category.categoryId} ({category.status})</li>)}</ul></>}
            {domainPreview.review.indexNotes.length > 0 && <><Typography.Text strong>{t('domainMigration.indexNotes')}</Typography.Text><ul>{domainPreview.review.indexNotes.map(note => <li key={`${note.sourcePath}:${note.targetTitle}`}>{note.sourcePath} → {note.targetTitle}</li>)}</ul></>}
            {domainPreview.review.unclassifiedIndexContent.length > 0 && <Alert type="warning" showIcon style={{ marginTop: 8 }} message={t('domainMigration.diagnostics')} description={<ul>{domainPreview.review.unclassifiedIndexContent.map((item, index) => <li key={`${item.sourcePath}:${index}`}>{item.sourcePath}</li>)}</ul>} />}
            {domainPreview.review.readonlyLogArchives.length > 0 && <><Typography.Text strong>{t('domainMigration.archives')}</Typography.Text><ul>{domainPreview.review.readonlyLogArchives.map(item => <li key={item.archivePath}>{item.sourcePath} → {item.archivePath}</li>)}</ul></>}
            {domainPreview.diagnostics.length > 0 && <Alert type="error" showIcon message={t('domainMigration.diagnostics')} description={<ul>{domainPreview.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}:${index}`}>{diagnostic.message} ({diagnostic.paths.join(', ')})</li>)}</ul>} />}
            {!domainPreview.changes.length && !domainPreview.diagnostics.length && <Typography.Paragraph>{t('domainMigration.noChanges')}</Typography.Paragraph>}
          </div>
        )}
      </Modal>
      <Modal
        open={migrationReport !== null}
        title={t('migration.reportTitle')}
        footer={
          <Button
            type="primary"
            onClick={() => {
              setMigrationReport(null)
              setExtraRootsInput('')
            }}
          >
            {t('migration.reportClose')}
          </Button>
        }
        onCancel={() => {
          setMigrationReport(null)
          setExtraRootsInput('')
        }}
        width={560}
      >
        {migrationReport && (
          <>
            <MigrationSummary text={t('migration.reportSummary', summarizeMigrationReport(migrationReport))} />
            <MigrationConflictSection
              title={t('migration.conflictsTitle')}
              conflicts={migrationReport.conflicts}
            />
            <MigrationFailureSection
              title={t('migration.failedTitle')}
              failures={(migrationReport.profiles ?? []).filter((p) => p.status === 'failed')}
            />
          </>
        )}
      </Modal>
    </div>
  )
})
