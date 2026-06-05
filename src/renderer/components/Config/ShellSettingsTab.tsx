import { Alert, Button, Form, Input, InputNumber, Select, Space, Table, Tooltip } from 'antd'
import { Info } from 'lucide-react'
import type { ShellConfig, ShellRule } from '../../../shared/domainTypes'
import { DEFAULT_SHELL_CONFIG } from '../../../shared/domainTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { ConfigResultAlert } from './ConfigResultAlert'

type Props = {
  shell: ShellConfig
  onChange: React.Dispatch<React.SetStateAction<ShellConfig>>
  onTestShell?: () => void
  shellTesting?: boolean
  shellTest?: { ok: boolean; text: string } | null
}

function SensitivePrefixesHelp() {
  const { t } = useTypedTranslation('config')
  return (
    <div className="config-field-help-tip">
      <p>{t('shell.sensitivePrefixesHelpIntro')}</p>
      <p>{t('shell.sensitivePrefixesHelpWhenTitle')}</p>
      <ul>
        <li>{t('shell.sensitivePrefixesHelpExample1')}</li>
        <li>{t('shell.sensitivePrefixesHelpExample2')}</li>
        <li>{t('shell.sensitivePrefixesHelpExample3')}</li>
      </ul>
      <p>{t('shell.sensitivePrefixesHelpOutro')}</p>
    </div>
  )
}

export function ShellSettingsTab({ shell, onChange, onTestShell, shellTesting, shellTest }: Props) {
  const { t } = useTypedTranslation('config')
  const { t: tCommon } = useTypedTranslation('common')

  const builtinDenyDisplay = [
    { pattern: 'sudo:*', reason: t('shell.builtinDenyReason.privilege') },
    { pattern: 'doas:*', reason: t('shell.builtinDenyReason.privilege') },
    { pattern: 'rm -rf:*', reason: t('shell.builtinDenyReason.destructiveDelete') },
    { pattern: 'lark-cli:*', reason: t('shell.builtinDenyReason.useRunLarkCli') }
  ]

  const patch = (partial: Partial<ShellConfig>) => onChange((s) => ({ ...s, ...partial }))

  const addRule = () => {
    const id = `rule-${Date.now()}`
    patch({ rules: [...(shell.rules ?? []), { id, pattern: 'git status', decision: 'allow', note: '' }] })
  }

  const updateRule = (id: string, partial: Partial<ShellRule>) => {
    patch({
      rules: (shell.rules ?? []).map((r) => (r.id === id ? { ...r, ...partial } : r))
    })
  }

  const removeRule = (id: string) => {
    patch({ rules: (shell.rules ?? []).filter((r) => r.id !== id) })
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="warning"
        showIcon
        icon={<Info size={16} strokeWidth={2} className="config-notice-icon" aria-hidden />}
        className="config-alert--compact config-alert--notice"
        message={t('shell.boundaryTitle')}
        description={t('shell.boundaryDescription')}
      />
      <Form.Item label={t('shell.defaultTimeoutLabel')}>
        <InputNumber
          min={1}
          max={86400}
          value={shell.shellDefaultTimeoutSec ?? DEFAULT_SHELL_CONFIG.shellDefaultTimeoutSec}
          onChange={(v) => patch({ shellDefaultTimeoutSec: v ?? 300 })}
          style={{ width: '100%' }}
        />
      </Form.Item>
      <Form.Item label={t('shell.outputModeLabel')}>
        <Select
          value={shell.outputMode ?? 'terminal'}
          style={{ width: '100%' }}
          options={[
            { value: 'terminal', label: t('shell.outputTerminal') },
            { value: 'plain', label: t('shell.outputPlain') }
          ]}
          onChange={(v) => patch({ outputMode: v })}
        />
        <p className="config-field__hint" style={{ marginTop: 6 }}>
          {t('shell.outputHint')}
        </p>
      </Form.Item>
      <Form.Item label={t('shell.maxInlineOutputLabel')}>
        <InputNumber
          min={1024}
          max={10_485_760}
          value={shell.maxInlineOutputBytes ?? DEFAULT_SHELL_CONFIG.maxInlineOutputBytes}
          onChange={(v) => patch({ maxInlineOutputBytes: v ?? 102400 })}
          style={{ width: '100%' }}
        />
      </Form.Item>
      <Form.Item
        label={
          <span className="config-field-label-with-help">
            {t('shell.sensitivePrefixesLabel')}
            <Tooltip
              title={<SensitivePrefixesHelp />}
              trigger="click"
              placement="topLeft"
              styles={{ root: { maxWidth: 320 } }}
            >
              <button type="button" className="config-field-help-trigger" aria-label={t('shell.sensitivePrefixesAria')}>
                ?
              </button>
            </Tooltip>
          </span>
        }
      >
        <Input.TextArea
          rows={3}
          value={(shell.customSensitivePrefixes ?? []).join('\n')}
          onChange={(e) => {
            const lines = e.target.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
            patch({ customSensitivePrefixes: lines.length ? lines : undefined })
          }}
          placeholder={t('shell.sensitivePrefixesPlaceholder')}
        />
      </Form.Item>

      <details className="config-shell-advanced">
        <summary>{t('shell.advancedSummary')}</summary>
        <Form.Item label={t('shell.executableLabel')} className="config-block-spacer">
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={shell.executable ?? ''}
              onChange={(e) => patch({ executable: e.target.value || undefined })}
              placeholder={t('shell.executablePlaceholder')}
            />
            {onTestShell ? (
              <Button loading={shellTesting} onClick={onTestShell}>
                {t('shell.test')}
              </Button>
            ) : null}
          </Space.Compact>
        </Form.Item>
        {shellTest ? <ConfigResultAlert ok={shellTest.ok} message={shellTest.text} /> : null}
      </details>

      <div>
        <div className="config-skill-section-header">
          <strong>{t('shell.rulesTitle')}</strong>
          <Button size="small" onClick={addRule}>
            {t('shell.addRule')}
          </Button>
        </div>
        <Table
          size="small"
          pagination={false}
          rowKey="id"
          dataSource={shell.rules ?? []}
          locale={{ emptyText: t('shell.emptyRules') }}
          columns={[
            {
              title: t('shell.columnPattern'),
              dataIndex: 'pattern',
              render: (_, row) => (
                <Input
                  size="small"
                  value={row.pattern}
                  onChange={(e) => updateRule(row.id, { pattern: e.target.value })}
                />
              )
            },
            {
              title: t('shell.columnDecision'),
              dataIndex: 'decision',
              width: 100,
              render: (_, row) => (
                <Select
                  size="small"
                  value={row.decision}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'allow', label: 'allow' },
                    { value: 'ask', label: 'ask' },
                    { value: 'deny', label: 'deny' }
                  ]}
                  onChange={(v) => updateRule(row.id, { decision: v })}
                />
              )
            },
            {
              title: t('shell.columnNote'),
              dataIndex: 'note',
              render: (_, row) => (
                <Input
                  size="small"
                  value={row.note ?? ''}
                  onChange={(e) => updateRule(row.id, { note: e.target.value })}
                />
              )
            },
            {
              title: '',
              width: 60,
              render: (_, row) => (
                <Button size="small" type="link" danger onClick={() => removeRule(row.id)}>
                  {tCommon('delete')}
                </Button>
              )
            }
          ]}
        />
        <p className="config-field__hint" style={{ marginTop: 8 }}>
          {t('shell.builtinDenyTitle')}
        </p>
        <ul className="config-field__hint">
          {builtinDenyDisplay.map((r) => (
            <li key={r.pattern}>
              {r.pattern} — {r.reason}
            </li>
          ))}
        </ul>
      </div>
    </Space>
  )
}
