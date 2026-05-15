import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { AppConfig } from '../../shared/domainTypes'

interface ConfigState {
  config: AppConfig | null
  settingsOpen: boolean
  aboutOpen: boolean
}

const initialState: ConfigState = {
  config: null,
  settingsOpen: false,
  aboutOpen: false
}

export const configSlice = createSlice({
  name: 'config',
  initialState,
  reducers: {
    setConfig(state, action: PayloadAction<AppConfig | null>) {
      state.config = action.payload
    },
    setSettingsOpen(state, action: PayloadAction<boolean>) {
      state.settingsOpen = action.payload
    },
    setAboutOpen(state, action: PayloadAction<boolean>) {
      state.aboutOpen = action.payload
    }
  }
})

export const { setConfig, setSettingsOpen, setAboutOpen } = configSlice.actions
export default configSlice.reducer
