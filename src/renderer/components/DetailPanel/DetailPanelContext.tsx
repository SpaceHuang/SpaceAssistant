import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { App } from 'antd'
import type { FileTypeCategory } from '../../../shared/fileTypes'
import { classifyFileType } from '../../../shared/fileTypes'
import type { FileReadResult } from '../../../shared/api'
import { normalizeViewerUrl } from '../../../shared/viewerUrl'
import { preloadShiki } from '../../utils/shikiHighlighter'
import {
  canGoBack,
  canGoForward,
  createUrlHistory,
  currentHistoryUrl,
  navigateBack,
  navigateForward,
  pushUrlHistory,
  type UrlHistoryState
} from './webViewHistory'

export type ViewMode = 'code' | 'render'
export type ContentMode = 'file' | 'url'

export type WebViewController = {
  reload: (ignoreCache?: boolean) => void
  stop: () => void
}

function defaultViewModeForFileType(fileType: FileTypeCategory | null): ViewMode {
  if (fileType === 'markdown' || fileType === 'html') return 'render'
  return 'code'
}

export type DetailPanelState = {
  contentMode: ContentMode
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
  selectedUrl: string | null
  displayUrl: string
  urlHistory: string[]
  historyIndex: number
  isWebViewLoading: boolean
  webViewError: string | null
  localFileViewerUrl: string | null
  canNavigateBack: boolean
  canNavigateForward: boolean
  isWebViewActive: boolean
}

export type DetailPanelActions = {
  openFile: (relPath: string) => Promise<void>
  openUrl: (url: string) => Promise<void>
  closeFile: () => void
  refreshFile: () => Promise<void>
  refreshPage: (ignoreCache?: boolean) => void
  stopLoading: () => void
  navigateBack: () => void
  navigateForward: () => void
  setViewMode: (mode: ViewMode) => void
  setDisplayUrl: (url: string) => void
  submitDisplayUrl: () => void
  setReferencedFilesHeight: (ratio: number) => void
  resetReferencedFilesHeight: () => void
  registerWebViewController: (controller: WebViewController | null) => void
  onWebViewLoadStart: () => void
  onWebViewLoadFinish: (url: string) => void
  onWebViewLoadError: (error: string) => void
  onWebViewLinkClick: (url: string, target: string) => void
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

async function resolveLocalViewerUrl(relPath: string): Promise<string | null> {
  const result = await window.api.fileToViewerUrl(relPath)
  return result.ok ? result.url : null
}

export function DetailPanelProvider({ children }: { children: ReactNode }) {
  const { message } = App.useApp()
  const webViewControllerRef = useRef<WebViewController | null>(null)
  const [contentMode, setContentMode] = useState<ContentMode>('file')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [fileType, setFileType] = useState<FileTypeCategory | null>(null)
  const [viewMode, setViewModeState] = useState<ViewMode>('code')
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [unsupportedExt, setUnsupportedExt] = useState<string | null>(null)
  const [tooLargeSize, setTooLargeSize] = useState<number | null>(null)
  const [referencedFilesHeight, setReferencedFilesHeightState] = useState(0.38)
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null)
  const [displayUrl, setDisplayUrl] = useState('')
  const [urlHistoryState, setUrlHistoryState] = useState<UrlHistoryState>(createUrlHistory())
  const [isWebViewLoading, setIsWebViewLoading] = useState(false)
  const [webViewError, setWebViewError] = useState<string | null>(null)
  const [localFileViewerUrl, setLocalFileViewerUrl] = useState<string | null>(null)

  useEffect(() => {
    void preloadShiki()
  }, [])

  const resetUrlState = useCallback(() => {
    setContentMode('file')
    setSelectedUrl(null)
    setDisplayUrl('')
    setUrlHistoryState(createUrlHistory())
    setIsWebViewLoading(false)
    setWebViewError(null)
    setLocalFileViewerUrl(null)
  }, [])

  const resetState = useCallback(() => {
    setSelectedFile(null)
    setPreviewContent(null)
    setImageDataUrl(null)
    setFileType(null)
    setViewModeState('code')
    setIsLoading(false)
    setLoadError(null)
    setUnsupportedExt(null)
    setTooLargeSize(null)
    resetUrlState()
  }, [resetUrlState])

  const syncLocalHtmlViewerUrl = useCallback(async (relPath: string, nextViewMode: ViewMode, nextFileType: FileTypeCategory | null) => {
    if (nextFileType !== 'html' || nextViewMode !== 'render') {
      setLocalFileViewerUrl(null)
      return
    }
    const url = await resolveLocalViewerUrl(relPath)
    setLocalFileViewerUrl(url)
    if (url) {
      setDisplayUrl(url)
    }
    if (!url) {
      setWebViewError('无法生成本地网页预览地址')
    }
  }, [])

  const loadFile = useCallback(async (relPath: string, options?: { preserveViewMode?: boolean }) => {
    resetUrlState()
    setIsLoading(true)
    setLoadError(null)
    setUnsupportedExt(null)
    setTooLargeSize(null)
    try {
      const result = await window.api.fileReadFile(relPath)
      const applied = applyReadResult(result, relPath)
      const nextViewMode = options?.preserveViewMode
        ? viewMode
        : defaultViewModeForFileType(applied.fileType)
      setSelectedFile(relPath)
      setPreviewContent(applied.previewContent)
      setImageDataUrl(applied.imageDataUrl)
      setFileType(applied.fileType)
      setLoadError(applied.loadError)
      setUnsupportedExt(applied.unsupportedExt)
      setTooLargeSize(applied.tooLargeSize)
      if (!options?.preserveViewMode) {
        setViewModeState(nextViewMode)
      }
      await syncLocalHtmlViewerUrl(relPath, nextViewMode, applied.fileType)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsLoading(false)
    }
  }, [resetUrlState, syncLocalHtmlViewerUrl, viewMode])

  const refreshPage = useCallback((ignoreCache = false) => {
    webViewControllerRef.current?.reload(ignoreCache)
  }, [])

  const openFile = useCallback(
    async (relPath: string) => {
      await loadFile(relPath)
    },
    [loadFile]
  )

  const openUrl = useCallback(
    async (rawUrl: string) => {
      const normalized = normalizeViewerUrl(rawUrl)
      if (!normalized) {
        message.error('无效的 URL')
        return
      }
      setSelectedFile(null)
      setPreviewContent(null)
      setImageDataUrl(null)
      setFileType(null)
      setViewModeState('code')
      setLoadError(null)
      setUnsupportedExt(null)
      setTooLargeSize(null)
      setLocalFileViewerUrl(null)
      setContentMode('url')
      setSelectedUrl(normalized)
      setDisplayUrl(normalized)
      setUrlHistoryState((prev) => pushUrlHistory(prev, normalized))
      setWebViewError(null)
      setIsWebViewLoading(true)
    },
    [message]
  )

  const closeFile = useCallback(() => {
    resetState()
  }, [resetState])

  const refreshFile = useCallback(async () => {
    if (contentMode === 'url' || (fileType === 'html' && viewMode === 'render')) {
      refreshPage()
      message.success('已刷新')
      return
    }
    if (!selectedFile) return
    await loadFile(selectedFile, { preserveViewMode: true })
    message.success('已刷新')
  }, [contentMode, fileType, loadFile, refreshPage, selectedFile, viewMode, message])

  const stopLoading = useCallback(() => {
    webViewControllerRef.current?.stop()
    setIsWebViewLoading(false)
  }, [])

  const navigateBackAction = useCallback(() => {
    setUrlHistoryState((prev) => {
      const next = navigateBack(prev)
      if (!next) return prev
      const url = currentHistoryUrl(next)
      if (url) {
        setSelectedUrl(url)
        setDisplayUrl(url)
        setIsWebViewLoading(true)
      }
      return next
    })
  }, [])

  const navigateForwardAction = useCallback(() => {
    setUrlHistoryState((prev) => {
      const next = navigateForward(prev)
      if (!next) return prev
      const url = currentHistoryUrl(next)
      if (url) {
        setSelectedUrl(url)
        setDisplayUrl(url)
        setIsWebViewLoading(true)
      }
      return next
    })
  }, [])

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      setViewModeState(mode)
      if (selectedFile) {
        void syncLocalHtmlViewerUrl(selectedFile, mode, fileType)
      }
    },
    [fileType, selectedFile, syncLocalHtmlViewerUrl]
  )

  const submitDisplayUrl = useCallback(() => {
    void openUrl(displayUrl)
  }, [displayUrl, openUrl])

  const registerWebViewController = useCallback((controller: WebViewController | null) => {
    webViewControllerRef.current = controller
  }, [])

  const onWebViewLoadStart = useCallback(() => {
    setIsWebViewLoading(true)
    setWebViewError(null)
  }, [])

  const onWebViewLoadFinish = useCallback(
    (url: string) => {
      setIsWebViewLoading(false)
      setWebViewError(null)
      if (contentMode === 'url') {
        setSelectedUrl(url)
        setDisplayUrl(url)
        setUrlHistoryState((prev) => {
          const current = currentHistoryUrl(prev)
          if (current === url) return prev
          return pushUrlHistory(prev, url)
        })
      }
    },
    [contentMode]
  )

  const onWebViewLoadError = useCallback((error: string) => {
    setIsWebViewLoading(false)
    setWebViewError(error)
  }, [])

  const onWebViewLinkClick = useCallback(
    (url: string, target: string) => {
      if (target === '_blank') {
        return
      }
      void openUrl(url)
    },
    [openUrl]
  )

  const setReferencedFilesHeight = useCallback((ratio: number) => {
    setReferencedFilesHeightState(Math.min(0.85, Math.max(0.15, ratio)))
  }, [])

  const resetReferencedFilesHeight = useCallback(() => {
    setReferencedFilesHeightState(0.38)
  }, [])

  const isWebViewActive =
    contentMode === 'url' || (fileType === 'html' && viewMode === 'render' && Boolean(localFileViewerUrl))

  const value = useMemo<DetailPanelContextValue>(
    () => ({
      contentMode,
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
      selectedUrl,
      displayUrl,
      urlHistory: urlHistoryState.history,
      historyIndex: urlHistoryState.index,
      isWebViewLoading,
      webViewError,
      localFileViewerUrl,
      canNavigateBack: canGoBack(urlHistoryState),
      canNavigateForward: canGoForward(urlHistoryState),
      isWebViewActive,
      openFile,
      openUrl,
      closeFile,
      refreshFile,
      refreshPage,
      stopLoading,
      navigateBack: navigateBackAction,
      navigateForward: navigateForwardAction,
      setViewMode,
      setDisplayUrl,
      submitDisplayUrl,
      setReferencedFilesHeight,
      resetReferencedFilesHeight,
      registerWebViewController,
      onWebViewLoadStart,
      onWebViewLoadFinish,
      onWebViewLoadError,
      onWebViewLinkClick
    }),
    [
      contentMode,
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
      selectedUrl,
      displayUrl,
      urlHistoryState,
      isWebViewLoading,
      webViewError,
      localFileViewerUrl,
      isWebViewActive,
      openFile,
      openUrl,
      closeFile,
      refreshFile,
      refreshPage,
      stopLoading,
      navigateBackAction,
      navigateForwardAction,
      setViewMode,
      submitDisplayUrl,
      setReferencedFilesHeight,
      resetReferencedFilesHeight,
      registerWebViewController,
      onWebViewLoadStart,
      onWebViewLoadFinish,
      onWebViewLoadError,
      onWebViewLinkClick
    ]
  )

  return <DetailPanelContext.Provider value={value}>{children}</DetailPanelContext.Provider>
}

export function useDetailPanel(): DetailPanelContextValue {
  const ctx = useContext(DetailPanelContext)
  if (!ctx) throw new Error('useDetailPanel must be used within DetailPanelProvider')
  return ctx
}
