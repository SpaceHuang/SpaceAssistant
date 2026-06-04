export const MAX_URL_HISTORY = 100

export type UrlHistoryState = {
  history: string[]
  index: number
}

export function createUrlHistory(initialUrl?: string): UrlHistoryState {
  if (!initialUrl) return { history: [], index: -1 }
  return { history: [initialUrl], index: 0 }
}

export function pushUrlHistory(state: UrlHistoryState, url: string): UrlHistoryState {
  if (state.index >= 0 && state.history[state.index] === url) {
    return state
  }
  const truncated = state.history.slice(0, state.index + 1)
  truncated.push(url)
  while (truncated.length > MAX_URL_HISTORY) {
    truncated.shift()
  }
  return { history: truncated, index: truncated.length - 1 }
}

export function navigateBack(state: UrlHistoryState): UrlHistoryState | null {
  if (state.index <= 0) return null
  return { ...state, index: state.index - 1 }
}

export function navigateForward(state: UrlHistoryState): UrlHistoryState | null {
  if (state.index >= state.history.length - 1) return null
  return { ...state, index: state.index + 1 }
}

export function currentHistoryUrl(state: UrlHistoryState): string | null {
  if (state.index < 0 || state.index >= state.history.length) return null
  return state.history[state.index] ?? null
}

export function canGoBack(state: UrlHistoryState): boolean {
  return state.index > 0
}

export function canGoForward(state: UrlHistoryState): boolean {
  return state.index >= 0 && state.index < state.history.length - 1
}
