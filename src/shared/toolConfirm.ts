export type ToolConfirmOptions = {
  trustCommand?: string
  trustDomain?: string
}

export type ToolConfirmHandler = (approved: boolean, options?: ToolConfirmOptions) => void
