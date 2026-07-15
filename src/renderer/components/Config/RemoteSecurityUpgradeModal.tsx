import { useMemo, useState } from 'react'
import { App, Modal, Radio, Space, Typography } from 'antd'
import type {
  EffectiveVerdict,
  RemoteSecurityMigrationPlan,
  RemoteSecurityPatch,
  RemoteSecurityPresetKind
} from '../../../shared/remoteSecurityMigration'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  open: boolean
  plan: RemoteSecurityMigrationPlan | null
  /** Atomically persists the chosen preset. Rejects on failure so the modal stays open. */
  onCommit: (patch: RemoteSecurityPatch) => Promise<void>
  /** Cancel/close must NOT change any config (version stays unmigrated). */
  onCancel: () => void
}

const VERDICT_TONE: Record<EffectiveVerdict, string> = {
  skip: 'success',
  confirm: 'warning',
  deny: 'danger'
}

export function RemoteSecurityUpgradeModal({ open, plan, onCommit, onCancel }: Props) {
  const { t } = useTypedTranslation('config')
  const { message } = App.useApp()
  const [preset, setPreset] = useState<RemoteSecurityPresetKind>('recommended')
  const [saving, setSaving] = useState(false)

  const rows = useMemo(() => {
    if (!plan) return []
    const s = plan.effectiveStrength
    return [
      { key: 'fileWrite', label: t('remoteSecurityUpgrade.itemFileWrite'), verdict: s.fileWrite },
      { key: 'scriptAllow', label: t('remoteSecurityUpgrade.itemScript'), verdict: s.scriptAllow },
      { key: 'browserNavigate', label: t('remoteSecurityUpgrade.itemNavigate'), verdict: s.browserNavigate },
      { key: 'browserAct', label: t('remoteSecurityUpgrade.itemAct'), verdict: s.browserAct },
      { key: 'larkWrite', label: t('remoteSecurityUpgrade.itemLarkWrite'), verdict: s.larkWrite }
    ]
  }, [plan, t])

  const handleOk = async () => {
    if (!plan) return
    const patch = preset === 'recommended' ? plan.recommended : plan.safer
    setSaving(true)
    try {
      await onCommit(patch)
    } catch {
      message.error(t('remoteSecurityUpgrade.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={t('remoteSecurityUpgrade.title')}
      okText={t('remoteSecurityUpgrade.confirm')}
      cancelText={t('remoteSecurityUpgrade.cancel')}
      confirmLoading={saving}
      onOk={handleOk}
      onCancel={onCancel}
      maskClosable={false}
      destroyOnClose
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary">
          {t('remoteSecurityUpgrade.intro')}
        </Typography.Paragraph>

        <div>
          <Typography.Text strong>{t('remoteSecurityUpgrade.currentTitle')}</Typography.Text>
          <ul style={{ marginTop: 8 }}>
            {rows.map((r) => (
              <li key={r.key}>
                {r.label}：
                <Typography.Text type={VERDICT_TONE[r.verdict] as never}>
                  {t(`remoteSecurityUpgrade.verdict.${r.verdict}` as never)}
                </Typography.Text>
              </li>
            ))}
          </ul>
        </div>

        {plan && plan.legacyMappings.length > 0 && (
          <Typography.Paragraph type="warning" style={{ margin: 0 }}>
            {t('remoteSecurityUpgrade.legacyNotice')}
          </Typography.Paragraph>
        )}

        <div>
          <Typography.Text strong>{t('remoteSecurityUpgrade.presetTitle')}</Typography.Text>
          <Radio.Group
            style={{ display: 'block', marginTop: 8 }}
            value={preset}
            onChange={(e) => setPreset(e.target.value as RemoteSecurityPresetKind)}
          >
            <Space direction="vertical">
              <Radio value="recommended">{t('remoteSecurityUpgrade.presetRecommended')}</Radio>
              <Radio value="safer">{t('remoteSecurityUpgrade.presetSafer')}</Radio>
            </Space>
          </Radio.Group>
        </div>
      </Space>
    </Modal>
  )
}
