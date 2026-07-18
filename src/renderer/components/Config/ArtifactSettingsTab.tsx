import { Form, Radio, Space, Switch, Typography } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export type ScratchGitPolicyChoice = 'add-ignore' | 'keep-visible' | 'ask'

export type ArtifactSettingsUi = {
  artifactManagementEnabled: boolean
  scratchGitPolicy: ScratchGitPolicyChoice
}

interface Props {
  value: ArtifactSettingsUi
  onChange: (v: ArtifactSettingsUi) => void
}

export function ArtifactSettingsTab({ value, onChange }: Props) {
  const { t } = useTypedTranslation('config')

  return (
    <Space direction="vertical" className="config-form-stack" style={{ width: '100%' }} size="middle">
      <Form layout="vertical">
        <Form.Item label={t('artifactSettings.enabledLabel')}>
          <Switch
            checked={value.artifactManagementEnabled}
            onChange={(enabled) => onChange({ ...value, artifactManagementEnabled: enabled })}
          />
        </Form.Item>
        <Typography.Paragraph type="secondary" className="config-field__hint">
          {t('artifactSettings.enabledHint')}
        </Typography.Paragraph>
        <Form.Item label={t('artifactSettings.scratchGitPolicyLabel')}>
          <Radio.Group
            value={value.scratchGitPolicy}
            onChange={(e) => onChange({ ...value, scratchGitPolicy: e.target.value })}
          >
            <Space direction="vertical">
              <Radio value="add-ignore">{t('artifactSettings.scratchGitPolicyAddIgnore')}</Radio>
              <Radio value="keep-visible">{t('artifactSettings.scratchGitPolicyKeepVisible')}</Radio>
              <Radio value="ask">{t('artifactSettings.scratchGitPolicyAsk')}</Radio>
            </Space>
          </Radio.Group>
        </Form.Item>
        <Typography.Paragraph type="secondary" className="config-field__hint">
          {t('artifactSettings.scratchGitPolicyHint')}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" className="config-field__hint">
          {t('artifactSettings.overviewHint')}
        </Typography.Paragraph>
      </Form>
    </Space>
  )
}
