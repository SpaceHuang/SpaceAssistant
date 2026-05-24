import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Button } from 'antd'
import { useTypedSelector } from '../../hooks'
import { DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'
import { FileTree, type FileTreeHandle } from '../FileTree/FileTree'
import { FileTreeToolbar } from '../FileTree/FileTreeToolbar'
import { FilePaneSection } from './FilePaneSection'
import { loadFilePaneSectionUi, saveFilePaneSectionUi } from '../../services/filePanePrefs'
import { isUnderWikiRoot, subscribeFilePaneSelect } from '../../services/filePaneNavigation'
import './filePane.css'

type Props = {
  workDir: string
  onFileSelect: (relPath: string) => void
  onCollectToWiki?: (relPath: string) => void
}

export function FilePane({ workDir, onFileSelect, onCollectToWiki }: Props) {
  const { message } = App.useApp()
  const cfg = useTypedSelector((s) => s.config.config)
  const wiki = cfg?.wiki ?? DEFAULT_WIKI_CONFIG
  const wikiRoot = wiki.rootPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')

  const [ui, setUi] = useState(loadFilePaneSectionUi)
  const [wikiInitialized, setWikiInitialized] = useState<boolean | null>(null)
  const [fileSelectedKey, setFileSelectedKey] = useState<string | null>(null)
  const [wikiSelectedKey, setWikiSelectedKey] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const fileTreeRef = useRef<FileTreeHandle>(null)
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
    saveFilePaneSectionUi(ui)
  }, [ui])

  useEffect(() => {
    return subscribeFilePaneSelect((req) => {
      const preferWiki = req.preferWiki ?? isUnderWikiRoot(req.relPath, wikiRoot)
      if (preferWiki && wiki.enabled) {
        setUi((prev) => ({ ...prev, llmWikiCollapsed: false }))
        setFileSelectedKey(null)
        void wikiTreeRef.current?.selectPath(req.relPath)
        setWikiSelectedKey(req.relPath.replace(/\\/g, '/'))
      } else {
        setUi((prev) => ({ ...prev, fileListCollapsed: false }))
        setWikiSelectedKey(null)
        void fileTreeRef.current?.selectPath(req.relPath)
        setFileSelectedKey(req.relPath.replace(/\\/g, '/'))
      }
    })
  }, [wiki.enabled, wikiRoot])

  const handleFileSelect = (relPath: string) => {
    setWikiSelectedKey(null)
    setFileSelectedKey(relPath)
    onFileSelect(relPath)
  }

  const handleWikiSelect = (relPath: string) => {
    setFileSelectedKey(null)
    setWikiSelectedKey(relPath)
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

  const showWikiSection = wiki.enabled
  const fileFlex = ui.fileListCollapsed ? 0 : showWikiSection && !ui.llmWikiCollapsed ? ui.fileListHeightRatio : 1
  const wikiFlex = ui.llmWikiCollapsed ? 0 : showWikiSection && !ui.fileListCollapsed ? 1 - ui.fileListHeightRatio : 1

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
  }

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const container = document.querySelector('.file-pane-sections')
      if (!container) return
      const rect = container.getBoundingClientRect()
      const ratio = (e.clientY - rect.top) / rect.height
      setUi((prev) => ({
        ...prev,
        fileListHeightRatio: Math.min(0.85, Math.max(0.15, ratio))
      }))
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  const excludePaths = useMemo(
    () => (wiki.enabled && wiki.hideWikiFromFileTree ? [wikiRoot] : []),
    [wiki.enabled, wiki.hideWikiFromFileTree, wikiRoot]
  )
  const fileListTreeOptions = useMemo(() => ({ excludePaths }), [excludePaths])

  return (
    <div className="file-pane">
      <div className="app-pane-header sider-content-header file-pane-toolbar">
        <span className="app-pane-header-title">文件</span>
        <FileTreeToolbar
          onNewDirectory={() => fileTreeRef.current?.startNewDirectory()}
          onRefresh={() => {
            void fileTreeRef.current?.refresh()
            void wikiTreeRef.current?.refresh()
          }}
        />
      </div>
      <div className="file-pane-sections">
        <FilePaneSection
          title="文件列表"
          collapsed={ui.fileListCollapsed}
          onToggle={() => setUi((prev) => ({ ...prev, fileListCollapsed: !prev.fileListCollapsed }))}
          flexGrow={fileFlex}
        >
          <FileTree
            ref={fileTreeRef}
            embedded
            workDir={workDir}
            selectedKey={fileSelectedKey}
            onSelectedKeyChange={setFileSelectedKey}
            onFileSelect={handleFileSelect}
            wikiRootPath={wikiRoot}
            wikiEnabled={wiki.enabled}
            onCollectToWiki={onCollectToWiki}
            treeOptions={fileListTreeOptions}
          />
        </FilePaneSection>

        {showWikiSection ? (
          <>
            {!ui.fileListCollapsed && !ui.llmWikiCollapsed ? (
              <div className="file-pane-resize-handle" onMouseDown={onResizeStart} />
            ) : null}
            <FilePaneSection
              title="LLM Wiki"
              collapsed={ui.llmWikiCollapsed}
              onToggle={() => setUi((prev) => ({ ...prev, llmWikiCollapsed: !prev.llmWikiCollapsed }))}
              flexGrow={wikiFlex}
              headerExtra={
                wikiInitialized ? (
                  <Button
                    type="text"
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation()
                      void window.api.fileShowInExplorer(wikiRoot)
                    }}
                  >
                    打开
                  </Button>
                ) : null
              }
            >
              {wikiInitialized === false ? (
                <div className="file-pane-wiki-placeholder">
                  <span>Wiki 尚未初始化</span>
                  <Button type="primary" size="small" onClick={() => void initWiki()}>
                    初始化 Wiki
                  </Button>
                </div>
              ) : (
                <FileTree
                  ref={wikiTreeRef}
                  embedded
                  workDir={workDir}
                  selectedKey={wikiSelectedKey}
                  onSelectedKeyChange={setWikiSelectedKey}
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
            </FilePaneSection>
          </>
        ) : null}
      </div>
    </div>
  )
}
