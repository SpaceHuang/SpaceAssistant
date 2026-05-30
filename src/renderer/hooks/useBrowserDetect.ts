import { useCallback, useEffect, useRef } from 'react'
import type { BrowserDetectResult } from '../../shared/browserTypes'
import { useAppDispatch, useTypedSelector } from '../hooks'
import { fetchBrowserDetect, setBrowserDetectResult } from '../store/browserDetectSlice'

type Options = {
  /** 为 true 时自动拉取（如进入「网络访问」子 Tab） */
  active?: boolean
  /** 工具失败时附带的检测结果，用于填充共享 cache */
  seed?: BrowserDetectResult | null
}

export function useBrowserDetect(options?: Options) {
  const dispatch = useAppDispatch()
  const { result, detecting, error } = useTypedSelector((s) => s.browserDetect)
  const seededRef = useRef(false)

  const refresh = useCallback(
    (force = false) => {
      void dispatch(fetchBrowserDetect(force))
    },
    [dispatch]
  )

  useEffect(() => {
    const seed = options?.seed
    if (!seed || seededRef.current) return
    if (!result) {
      dispatch(setBrowserDetectResult(seed))
    }
    seededRef.current = true
  }, [dispatch, options?.seed, result])

  useEffect(() => {
    if (!options?.active) return
    void dispatch(fetchBrowserDetect(false))
  }, [dispatch, options?.active])

  return { detect: result, detecting, error, refresh }
}
