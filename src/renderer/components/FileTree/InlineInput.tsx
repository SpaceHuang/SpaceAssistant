import { useRef, useEffect } from 'react'

interface InlineInputProps {
  defaultValue: string
  onConfirm: (name: string) => void
  onCancel: () => void
}

export function InlineInput({ defaultValue, onConfirm, onCancel }: InlineInputProps) {
  const ref = useRef<HTMLInputElement>(null)
  const confirmedRef = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [])

  const handleConfirm = () => {
    if (confirmedRef.current) return
    confirmedRef.current = true
    const val = ref.current?.value.trim() ?? ''
    if (val) {
      onConfirm(val)
    } else {
      onCancel()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleConfirm()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      confirmedRef.current = true
      onCancel()
    }
  }

  return (
    <input
      ref={ref}
      defaultValue={defaultValue}
      onKeyDown={handleKeyDown}
      onBlur={handleConfirm}
      style={{
        width: '100%',
        border: '1px solid #1677ff',
        borderRadius: 4,
        padding: '0 4px',
        fontSize: 12,
        lineHeight: '20px',
        outline: 'none',
        background: '#fff'
      }}
    />
  )
}