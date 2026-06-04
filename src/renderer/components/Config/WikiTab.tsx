import { App, Button, Input, InputNumber, Space, Switch } from 'antd'
import type { WikiConfig } from '../../../shared/domainTypes'
import { ConfigField, ConfigSettingsStack, ConfigSwitchRow } from './ConfigField'
import { formatUserFacingError } from '../../utils/formatUserFacingError'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  wiki: WikiConfig
  onChange: (next: WikiConfig) => void
}

export function WikiTab({ wiki, onChange }: Props) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('config')

  const initWiki = async () => {
    const result = await window.api.wikiInit({ installSkill: true })
    if (!result.ok) {
      message.error(formatUserFacingError(result.error))
      return
    }
    message.success(
      t('wiki.initSuccess', {
        path: result.rootPath,
        skillSuffix: result.skillInstalled ? t('wiki.skillInstalledSuffix') : ''
      })
    )
    await window.api.skillInvalidateCache()
  }

  return (
    <ConfigSettingsStack>
      <ConfigSwitchRow
        label={t('wiki.enableLabel')}
        checked={wiki.enabled}
        onChange={(enabled) => onChange({ ...wiki, enabled })}
      />
      <ConfigField label={t('wiki.rootPathLabel')}>
        <Input
          value={wiki.rootPath}
          onChange={(e) => onChange({ ...wiki, rootPath: e.target.value.trim() || 'llm-wiki' })}
          placeholder={t('wiki.rootPathPlaceholder')}
        />
      </ConfigField>
      <ConfigSwitchRow
        label={t('wiki.hideFromTreeLabel')}
        checked={wiki.hideWikiFromFileTree}
        onChange={(hideWikiFromFileTree) => onChange({ ...wiki, hideWikiFromFileTree })}
      />
      <ConfigSwitchRow
        label={t('wiki.interactiveIngestLabel')}
        checked={wiki.interactiveIngest}
        onChange={(interactiveIngest) => onChange({ ...wiki, interactiveIngest })}
      />
      <ConfigField label={t('wiki.maxBatchIngestLabel')}>
        <InputNumber
          min={1}
          max={50}
          value={wiki.maxBatchIngest}
          onChange={(v) => onChange({ ...wiki, maxBatchIngest: v ?? 10 })}
          style={{ width: '100%' }}
        />
      </ConfigField>
      <Button type="primary" onClick={() => void initWiki()} disabled={!wiki.enabled}>
        {t('wiki.initButton')}
      </Button>
    </ConfigSettingsStack>
  )
}
