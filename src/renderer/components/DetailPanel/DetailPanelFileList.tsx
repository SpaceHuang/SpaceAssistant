import { useEffect, useMemo, useRef, useState } from 'react'
import { useTypedSelector } from '../../hooks'
import { DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'
import { FileTree, type FileTreeHandle } from '../FileTree/FileTree'
import { FileTreeToolbar } from '../FileTree/FileTreeToolbar'
import { WorkDirSelector } from './WorkDirSelector'
import { isUnderWikiRoot, subscribeFilePaneSelect } from '../../services/filePaneNavigation'

type Props = {
  workDir: string
  onFileSelect: (relPath: string) => void
  onCollectToWiki?: (relPath: string) => void
}

export function DetailPanelFileList({ workDir, onFileSelect, onCollectToWiki }: Props) {
  const cfg = useTypedSelector((s) => s.config.config)
  const activeProfileId =
    cfg?.activeWorkDirProfileId ?? cfg?.workDirProfiles?.find((p) => p.isDefault)?.id ?? ''
  const wiki = cfg?.wiki ?? DEFAULT_WIKI_CONFIG
  const wikiRoot = wiki.rootPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')

  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  useEffect(() => {
    setSelectedKey(null)
  }, [activeProfileId])
  const fileTreeRef = useRef<FileTreeHandle>(null)

  const excludePaths = useMemo(
    () => (wiki.enabled && wiki.hideWikiFromFileTree ? [wikiRoot] : []),
    [wiki.enabled, wiki.hideWikiFromFileTree, wikiRoot]
  )
  const treeOptions = useMemo(() => ({ excludePaths }), [excludePaths])

  useEffect(() => {
    return subscribeFilePaneSelect((req) => {
      const preferWiki = req.preferWiki ?? isUnderWikiRoot(req.relPath, wikiRoot)
      if (preferWiki && wiki.enabled) {
        setSelectedKey(null)
        return
      }
      void fileTreeRef.current?.selectPath(req.relPath)
      setSelectedKey(req.relPath.replace(/\\/g, '/'))
    })
  }, [wiki.enabled, wikiRoot])

  const handleFileSelect = (relPath: string) => {
    setSelectedKey(relPath)
    onFileSelect(relPath)
  }

  return (
    <>
      <div className="detail-panel-section-header detail-panel-file-header">
        <WorkDirSelector />
        <FileTreeToolbar
          onNewDirectory={() => fileTreeRef.current?.startNewDirectory()}
          onRefresh={() => void fileTreeRef.current?.refresh()}
        />
      </div>
      <div className="detail-panel-file-body">
        <FileTree
          key={activeProfileId || workDir}
          ref={fileTreeRef}
          embedded
          workDir={workDir}
          selectedKey={selectedKey}
          onSelectedKeyChange={setSelectedKey}
          onFileSelect={handleFileSelect}
          wikiRootPath={wikiRoot}
          wikiEnabled={wiki.enabled}
          onCollectToWiki={onCollectToWiki}
          treeOptions={treeOptions}
        />
      </div>
    </>
  )
}
