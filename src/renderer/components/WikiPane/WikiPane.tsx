import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Button } from 'antd'
import { useTypedSelector } from '../../hooks'
import { DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'
import { FileTree, type FileTreeHandle } from '../FileTree/FileTree'
import { isUnderWikiRoot, subscribeFilePaneSelect } from '../../services/filePaneNavigation'
import { WikiPaneToolbar } from './WikiPaneToolbar'
import './wikiPane.css'

type Props = {
  workDir: string
  onFileSelect: (relPath: string) => void
  onSwitchToWikiTab: () => void
  onCollectToWiki?: (relPath: string) => void
}

export function WikiPane({ workDir, onFileSelect, onSwitchToWikiTab, onCollectToWiki }: Props) {
  const { message } = App.useApp()
  const cfg = useTypedSelector((s) => s.config.config)
  const wiki = cfg?.wiki ?? DEFAULT_WIKI_CONFIG
  const wikiRoot = wiki.rootPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')

  const [wikiInitialized, setWikiInitialized] = useState<boolean | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const wikiTreeRef = useRef<FileTreeHandle>(null)

  const wikiIndexPath = `${wikiRoot}/wiki/index.md`
  const highlightPaths = useMemo(() => [wikiIndexPath], [wikiIndexPath])

  const refreshWikiStatus = useCallback(async () => {
    if (!wiki.enabled) {
      setWikiInitialized(null)
      return
    }
    const status = await window.api.wikiStatus()
    setWikiInitialized(status.initialized)
  }, [wiki.enabled])

  useEffect(() => {
    void refreshWikiStatus()
  }, [refreshWikiStatus, wikiRoot])

  useEffect(() => {
    return subscribeFilePaneSelect((req) => {
      const preferWiki = req.preferWiki ?? isUnderWikiRoot(req.relPath, wikiRoot)
      if (!preferWiki || !wiki.enabled) {
        setSelectedKey(null)
        return
      }
      onSwitchToWikiTab()
      void wikiTreeRef.current?.selectPath(req.relPath)
      setSelectedKey(req.relPath.replace(/\\/g, '/'))
    })
  }, [wiki.enabled, wikiRoot, onSwitchToWikiTab])

  const handleWikiSelect = (relPath: string) => {
    setSelectedKey(relPath)
    onFileSelect(relPath)
  }

  const initWiki = async () => {
    const result = await window.api.wikiInit({ installSkill: true })
    if (!result.ok) {
      message.error(result.error)
      return
    }
    message.success('Wiki 已初始化')
    await window.api.skillInvalidateCache()
    await refreshWikiStatus()
    void wikiTreeRef.current?.refresh()
  }

  return (
    <div className="wiki-pane">
      <div className="app-pane-header sider-content-header wiki-pane-header">
        <span className="app-pane-header-title">Wiki</span>
        <WikiPaneToolbar
          showOpen={wikiInitialized === true}
          refreshDisabled={!wikiInitialized}
          onOpen={() => void window.api.fileShowInExplorer(wikiRoot)}
          onRefresh={() => void wikiTreeRef.current?.refresh()}
        />
      </div>
      <div className="wiki-pane-body">
        {wikiInitialized === false ? (
          <div className="wiki-pane-empty">
            <p className="wiki-pane-empty-title">Wiki 尚未初始化</p>
            <p className="wiki-pane-empty-desc">初始化后将创建 Wiki 目录与索引页，便于 Agent 归档与检索。</p>
            <Button type="primary" size="small" className="wiki-pane-init-btn" onClick={() => void initWiki()}>
              初始化 Wiki
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
            wikiEnabled={wiki.enabled}
            onCollectToWiki={onCollectToWiki}
            treeOptions={{
              rootRelPath: wikiRoot,
              rootDisplayName: wikiRoot.split('/').pop() || 'llm-wiki',
              readOnly: true
            }}
          />
        )}
      </div>
    </div>
  )
}
