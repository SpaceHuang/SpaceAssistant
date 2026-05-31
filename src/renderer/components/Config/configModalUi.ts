/** 设置弹窗内 Select 下拉层（挂载在 body，需独立 class） */
export const CONFIG_MODAL_SELECT_POPUP = 'config-modal-select-popup'

export const CONFIG_MODAL_MODEL_SELECT_POPUP = `${CONFIG_MODAL_SELECT_POPUP} config-model-select-popup`

/** @see antd Select `classNames.popup.root`（替代已废弃的 popupClassName） */
export const configModalSelectPopupClassNames = {
  popup: { root: CONFIG_MODAL_SELECT_POPUP }
} as const

export const configModalModelSelectPopupClassNames = {
  popup: { root: CONFIG_MODAL_MODEL_SELECT_POPUP }
} as const
