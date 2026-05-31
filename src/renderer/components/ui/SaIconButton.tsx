import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

type Size = 'sm' | 'md' | 'lg'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: Size
  active?: boolean
  children: ReactNode
}

const sizeClass: Record<Size, string> = {
  sm: 'sa-icon-btn--sm',
  md: 'sa-icon-btn--md',
  lg: 'sa-icon-btn--lg'
}

export const SaIconButton = forwardRef<HTMLButtonElement, Props>(function SaIconButton(
  { size = 'md', active, className = '', children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`sa-icon-btn ${sizeClass[size]}${active ? ' sa-icon-btn--active' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
})
