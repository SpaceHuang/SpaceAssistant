import type { FilePaneSectionUiState } from '../../shared/domainTypes'
import { DEFAULT_FILE_PANE_SECTION_UI } from '../../shared/domainTypes'

const STORAGE_KEY = 'sa.layout.filePaneSections'

export function loadFilePaneSectionUi(): FilePaneSectionUiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_FILE_PANE_SECTION_UI }
    const parsed = JSON.parse(raw) as Partial<FilePaneSectionUiState>
    return {
      fileListCollapsed: Boolean(parsed.fileListCollapsed),
      llmWikiCollapsed: Boolean(parsed.llmWikiCollapsed),
      fileListHeightRatio:
        typeof parsed.fileListHeightRatio === 'number'
          ? Math.min(0.85, Math.max(0.15, parsed.fileListHeightRatio))
          : DEFAULT_FILE_PANE_SECTION_UI.fileListHeightRatio
    }
  } catch {
    return { ...DEFAULT_FILE_PANE_SECTION_UI }
  }
}

export function saveFilePaneSectionUi(state: FilePaneSectionUiState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}
