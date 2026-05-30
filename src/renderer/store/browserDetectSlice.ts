import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { BrowserDetectResult } from '../../shared/browserTypes'

const CLIENT_DETECT_TTL_MS = 30_000

export interface BrowserDetectState {
  result: BrowserDetectResult | null
  detecting: boolean
  error: string | null
  lastFetchedAt: number | null
}

const initialState: BrowserDetectState = {
  result: null,
  detecting: false,
  error: null,
  lastFetchedAt: null
}

export const fetchBrowserDetect = createAsyncThunk<
  BrowserDetectResult,
  boolean | undefined,
  { state: { browserDetect: BrowserDetectState }; rejectValue: string }
>('browserDetect/fetch', async (force, { getState, rejectWithValue }) => {
  try {
    const { result, lastFetchedAt } = getState().browserDetect
    if (
      !force &&
      result &&
      lastFetchedAt !== null &&
      Date.now() - lastFetchedAt < CLIENT_DETECT_TTL_MS
    ) {
      return result
    }
    return await window.api.browserDetect(force === true)
  } catch (e) {
    return rejectWithValue(e instanceof Error ? e.message : String(e))
  }
})

const browserDetectSlice = createSlice({
  name: 'browserDetect',
  initialState,
  reducers: {
    setBrowserDetectResult(state, action: PayloadAction<BrowserDetectResult>) {
      state.result = action.payload
      state.error = null
      state.lastFetchedAt = Date.now()
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchBrowserDetect.pending, (state) => {
        state.detecting = true
        state.error = null
      })
      .addCase(fetchBrowserDetect.fulfilled, (state, action) => {
        state.detecting = false
        state.result = action.payload
        state.lastFetchedAt = Date.now()
      })
      .addCase(fetchBrowserDetect.rejected, (state, action) => {
        state.detecting = false
        state.error = action.payload ?? '检测失败'
      })
  }
})

export const { setBrowserDetectResult } = browserDetectSlice.actions
export default browserDetectSlice.reducer
