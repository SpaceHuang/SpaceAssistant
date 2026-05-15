import { Typography } from 'antd'

const { Text } = Typography

type Props = {
  hints: string[]
}

export function SkillHintBubble({ hints }: Props) {
  if (hints.length === 0) return null
  return (
    <>
      {hints.map((hint, i) => (
        <div key={`${i}-${hint.slice(0, 24)}`} style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
          <Text
            type="secondary"
            style={{
              fontSize: 12,
              background: 'var(--sa-skill-hint-bg, #f5f5f5)',
              padding: '4px 12px',
              borderRadius: 8,
              whiteSpace: 'pre-wrap',
              textAlign: 'center'
            }}
          >
            {hint}
          </Text>
        </div>
      ))}
    </>
  )
}
