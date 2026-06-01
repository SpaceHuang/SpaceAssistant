import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { App } from 'antd'
import type { FileTypeCategory } from '../../../shared/fileTypes'
import { classifyFileType } from '../../../shared/fileTypes'
import type { FileReadResult } from '../../../shared/api'
import { preloadShiki } from '../../utils/shikiHighlighter'

export type ViewMode = 'code' | 'render'

function defaultViewModeForFileType(fileType: FileTypeCategory | null): ViewMode {
  return fileType === 'markdown' ? 'render' : 'code'
}

export type DetailPanelState = {
  selectedFile: string | null
  previewContent: string | null
  imageDataUrl: string | null
  fileType: FileTypeCategory | null
  viewMode: ViewMode
  isLoading: boolean
  loadError: string | null
  unsupportedExt: string | null
  tooLargeSize: number | null
  referencedFilesHeight: number
}

export type DetailPanelActions = {
  openFile: (relPath: string) => Promise<void>
  closeFile: () => void
  refreshFile: () => Promise<void>
  setViewMode: (mode: ViewMode) => void
  setReferencedFilesHeight: (ratio: number) => void
  resetReferencedFilesHeight: () => void
}

type DetailPanelContextValue = DetailPanelState & DetailPanelActions

const DetailPanelContext = createContext<DetailPanelContextValue | null>(null)

function applyReadResult(
  result: FileReadResult,
  relPath: string
): Pick<
  DetailPanelState,
  'previewContent' | 'imageDataUrl' | 'fileType' | 'loadError' | 'unsupportedExt' | 'tooLargeSize'
> {
  const fileType = classifyFileType(relPath)
  if (result.kind === 'too_large') {
    return {
      previewContent: null,
      imageDataUrl: null,
      fileType,
      loadError: '文件过大，无法预览（最大 2MB）',
      unsupportedExt: null,
      tooLargeSize: result.size
    }
  }
  if (result.kind === 'unsupported') {
    return {
      previewContent: null,
      imageDataUrl: null,
      fileType: 'unsupported',
      loadError: null,
      unsupportedExt: result.ext,
      tooLargeSize: null
    }
  }
  if (result.kind === 'image') {
    return {
      previewContent: null,
      imageDataUrl: `data:${result.mimeType};base64,${result.content}`,
      fileType: 'image',
      loadError: null,
      unsupportedExt: null,
      tooLargeSize: null
    }
  }
  return {
    previewContent: result.content,
    imageDataUrl: null,
    fileType,
    loadError: null,
    unsupportedExt: null,
    tooLargeSize: null
  }
}

export function DetailPanelProvider({ children }: { children: ReactNode }) {
  const { message } = App.useApp()
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [fileType, setFileType] = useState<FileTypeCategory | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('code')
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [unsupportedExt, setUnsupportedExt] = useState<string | null>(null)
  const [tooLargeSize, setTooLargeSize] = useState<number | null>(null)
  const [referencedFilesHeight, setReferencedFilesHeightState] = useState(0.38)

  useEffect(() => {
    void preloadShiki()
  }, [])

  const resetState = useCallback(() => {
    setSelectedFile(null)
    setPreviewContent(null)
    setImageDataUrl(null)
    setFileType(null)
    setViewMode('code')
    setIsLoading(false)
    setLoadError(null)
    setUnsupportedExt(null)
    setTooLargeSize(null)
  }, [])

  const loadFile = useCallback(async (relPath: string, options?: { preserveViewMode?: boolean }) => {
    setIsLoading(true)
    setLoadError(null)
    setUnsupportedExt(null)
    setTooLargeSize(null)
    try {
      const result = await window.api.fileReadFile(relPath)
      const applied = applyReadResult(result, relPath)
      setSelectedFile(relPath)
      setPreviewContent(applied.previewContent)
      setImageDataUrl(applied.imageDataUrl)
      setFileType(applied.fileType)
      setLoadError(applied.loadError)
      setUnsupportedExt(applied.unsupportedExt)
      setTooLargeSize(applied.tooLargeSize)
      if (!options?.preserveViewMode) {
        setViewMode(defaultViewModeForFileType(applied.fileType))
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsLoading(false)
    }
  }, [])

  const openFile = useCallback(
    async (relPath: string) => {
      await loadFile(relPath)
    },
    [loadFile]
  )

  const closeFile = useCallback(() => {
    resetState()
  }, [resetState])

  const refreshFile = useCallback(async () => {
    if (!selectedFile) return
    await loadFile(selectedFile, { preserveViewMode: true })
    message.success('已刷新')
  }, [loadFile, selectedFile, message])

  const setReferencedFilesHeight = useCallback((ratio: number) => {
    setReferencedFilesHeightState(Math.min(0.85, Math.max(0.15, ratio)))
  }, [])

  const resetReferencedFilesHeight = useCallback(() => {
    setReferencedFilesHeightState(0.38)
  }, [])

  const value = useMemo<DetailPanelContextValue>(
    () => ({
      selectedFile,
      previewContent,
      imageDataUrl,
      fileType,
      viewMode,
      isLoading,
      loadError,
      unsupportedExt,
      tooLargeSize,
      referencedFilesHeight,
      openFile,
      closeFile,
      refreshFile,
      setViewMode,
      setReferencedFilesHeight,
      resetReferencedFilesHeight
    }),
    [
      selectedFile,
      previewContent,
      imageDataUrl,
      fileType,
      viewMode,
      isLoading,
      loadError,
      unsupportedExt,
      tooLargeSize,
      referencedFilesHeight,
      openFile,
      closeFile,
      refreshFile,
      setReferencedFilesHeight,
      resetReferencedFilesHeight
    ]
  )

  return <DetailPanelContext.Provider value={value}>{children}</DetailPanelContext.Provider>
}

export function useDetailPanel(): DetailPanelContextValue {
  const ctx = useContext(DetailPanelContext)
  if (!ctx) throw new Error('useDetailPanel must be used within DetailPanelProvider')
  return ctx
}
