import type { ReactNode } from 'react'
import { Space, Switch } from 'antd'
import type { SwitchProps } from 'antd'

type FieldProps = {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  className?: string
}

export function ConfigField({ label, hint, children, className }: FieldProps) {
  return (
    <div className={['config-field', className].filter(Boolean).join(' ')}>
      <div className="config-field__label">{label}</div>
      {hint ? <div className="config-field__hint">{hint}</div> : null}
      <div className="config-field__control">{children}</div>
    </div>
  )
}

type SwitchRowProps = {
  label: ReactNode
  hint?: ReactNode
  checked: boolean
  onChange: SwitchProps['onChange']
}

export function ConfigSwitchRow({ label, hint, checked, onChange }: SwitchRowProps) {
  return (
    <div className="config-field">
      <div className="config-field-row">
        <span className="config-field__label">{label}</span>
        <Switch checked={checked} onChange={onChange} />
      </div>
      {hint ? <div className="config-field__hint">{hint}</div> : null}
    </div>
  )
}

type StackProps = {
  children: ReactNode
  className?: string
}

export function ConfigSettingsStack({ children, className }: StackProps) {
  return (
    <Space direction="vertical" size="middle" className={['config-settings-stack', className].filter(Boolean).join(' ')}>
      {children}
    </Space>
  )
}
