import { Alert, Button, Form, Input, InputNumber, Select, Space, Table, Tooltip } from 'antd'
import type { ShellConfig, ShellRule } from '../../../shared/domainTypes'
import { DEFAULT_SHELL_CONFIG } from '../../../shared/domainTypes'

type Props = {
  shell: ShellConfig
  onChange: React.Dispatch<React.SetStateAction<ShellConfig>>
  onTestShell?: () => void
  shellTesting?: boolean
  shellTest?: { ok: boolean; text: string } | null
}

const CUSTOM_SENSITIVE_PREFIXES_HELP = (
  <div className="config-field-help-tip">
    <p>把需要特别小心的文件夹路径填在这里。AI 用 Shell 动到这些目录时，会先弹出明显警告，需要你明确确认才会执行。</p>
    <p>适合添加的情况，例如：</p>
    <ul>
      <li>团队密钥、证书、生产配置所在目录</li>
      <li>本地数据库备份、内网凭据文件夹</li>
      <li>任何你不希望 AI 悄无声息碰到的目录</li>
    </ul>
    <p>没有这类目录可以留空；系统本身还会保护 .ssh、.env 等常见敏感位置。</p>
  </div>
)

const BUILTIN_DENY_DISPLAY = [
  { pattern: 'sudo:*', reason: '提权' },
  { pattern: 'doas:*', reason: '提权' },
  { pattern: 'rm -rf:*', reason: '破坏性删除' },
  { pattern: 'lark-cli:*', reason: '请使用 run_lark_cli' }
]

export function ShellSettingsTab({ shell, onChange, onTestShell, shellTesting, shellTest }: Props) {
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
        className="config-alert--compact"
        message="Shell 命令能力边界"
        description="Shell 在会话工作目录下启动，系统会扫描命令中的路径并在越界/敏感时显著警示；注入类高危模式会直接拒绝。Shell 无法像文件工具一样约束子进程的全部行为。请勿对不可信命令点击确认。"
      />
      <Form.Item label="默认超时（秒）">
        <InputNumber
          min={1}
          max={86400}
          value={shell.shellDefaultTimeoutSec ?? DEFAULT_SHELL_CONFIG.shellDefaultTimeoutSec}
          onChange={(v) => patch({ shellDefaultTimeoutSec: v ?? 300 })}
          style={{ width: '100%' }}
        />
      </Form.Item>
      <Form.Item label="命令输出">
        <Select
          value={shell.outputMode ?? 'terminal'}
          style={{ width: '100%' }}
          options={[
            { value: 'terminal', label: '终端视图（ANSI / 进度条）' },
            { value: 'plain', label: '纯文本（v1）' }
          ]}
          onChange={(v) => patch({ outputMode: v })}
        />
        <p className="config-field__hint" style={{ marginTop: 6 }}>
          飞书远程会话始终使用纯文本。交互式全屏命令（less、vim、top 等）请在外部终端运行。
        </p>
      </Form.Item>
      <Form.Item label="内联输出上限（字节）">
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
            自定义敏感路径前缀
            <Tooltip
              title={CUSTOM_SENSITIVE_PREFIXES_HELP}
              trigger="click"
              placement="topLeft"
              styles={{ root: { maxWidth: 320 } }}
            >
              <button type="button" className="config-field-help-trigger" aria-label="自定义敏感路径前缀说明">
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
          placeholder="每行一个路径，例如：D:\secrets"
        />
      </Form.Item>

      <details className="config-shell-advanced">
        <summary>高级：自定义 Shell 可执行路径</summary>
        <Form.Item label="可执行文件路径" className="config-block-spacer">
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={shell.executable ?? ''}
              onChange={(e) => patch({ executable: e.target.value || undefined })}
              placeholder="留空使用平台默认（Windows: cmd，Unix: bash）"
            />
            {onTestShell ? (
              <Button loading={shellTesting} onClick={onTestShell}>
                测试
              </Button>
            ) : null}
          </Space.Compact>
        </Form.Item>
        {shellTest ? (
          <Alert type={shellTest.ok ? 'success' : 'error'} message={shellTest.text} showIcon className="config-alert-block" />
        ) : null}
      </details>

      <div>
        <div className="config-skill-section-header">
          <strong>命令规则（allow 可跳过确认）</strong>
          <Button size="small" onClick={addRule}>
            添加规则
          </Button>
        </div>
        <Table
          size="small"
          pagination={false}
          rowKey="id"
          dataSource={shell.rules ?? []}
          locale={{ emptyText: '暂无自定义规则；默认均需确认' }}
          columns={[
            {
              title: '模式',
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
              title: '决策',
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
              title: '备注',
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
                  删除
                </Button>
              )
            }
          ]}
        />
        <p className="config-field__hint" style={{ marginTop: 8 }}>
          内置 deny 规则（不可删除）：
        </p>
        <ul className="config-field__hint">
          {BUILTIN_DENY_DISPLAY.map((r) => (
            <li key={r.pattern}>
              {r.pattern} — {r.reason}
            </li>
          ))}
        </ul>
      </div>
    </Space>
  )
}
