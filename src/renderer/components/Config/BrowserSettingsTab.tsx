import { Alert, Button, Select, Tooltip } from 'antd'
import { useMemo, useState } from 'react'
import type { BrowserConfig, ModelEntry } from '../../../shared/domainTypes'
import {
  BROWSER_SETUP_REPAIR_INITIAL_MESSAGE,
  BROWSER_SETUP_REPAIR_SESSION_NAME
} from '../../../shared/domainTypes'
import { BrowserDetectStatusSummary } from '../Browser/BrowserDetectStatusSummary'
import { useBrowserDetect } from '../../hooks/useBrowserDetect'
import { useAppDispatch } from '../../hooks'
import { setSettingsOpen } from '../../store/configSlice'
import { setChatLaunchIntent } from '../../store/chatLaunchSlice'
import { setSession } from '../../store/chatSlice'
import { upsertSession } from '../../store/sessionSlice'
import refresh2LineRaw from '../../assets/refresh_2_line.svg?raw'
import { patchSvg } from '../../utils/patchSvg'
import { SaIconButton } from '../ui/SaIconButton'
import { ConfigModelOptionContent, sortModelsFastFirst } from './ConfigModelOption'
import { configModalModelSelectPopupClassNames, configModalSelectPopupClassNames } from './configModalUi'
import { ConfigField, ConfigSettingsStack, ConfigSwitchRow } from './ConfigField'

const refreshSvg = patchSvg(refresh2LineRaw)

type Props = {
  browser: BrowserConfig
  onChange: (next: BrowserConfig) => void
  models?: ModelEntry[]
  /** 进入「网络访问」子 Tab 时为 true，用于触发依赖检测 */
  active?: boolean
}

export function BrowserSettingsTab({ browser, onChange, models = [], active = false }: Props) {
  const dispatch = useAppDispatch()
  const { detect, detecting, refresh } = useBrowserDetect({ active })
  const [repairLoading, setRepairLoading] = useState(false)

  const patch = (p: Partial<BrowserConfig>) => onChange({ ...browser, ...p })
  const stagehandModels = useMemo(
    () => sortModelsFastFirst(models.filter((m) => m.enabled)),
    [models]
  )

  const handleRepairInChat = async () => {
    if (repairLoading) return
    setRepairLoading(true)
    try {
      dispatch(setSettingsOpen(false))
      const session = await window.api.sessionCreate({
        name: BROWSER_SETUP_REPAIR_SESSION_NAME,
        metadata: { chatLaunchSource: 'browser-settings-repair' }
      })
      dispatch(upsertSession(session))
      dispatch(setSession(session.id))
      dispatch(
        setChatLaunchIntent({
          sessionId: session.id,
          skillName: 'browser-setup-guide',
          initialUserMessage: BROWSER_SETUP_REPAIR_INITIAL_MESSAGE,
          source: 'browser-settings-repair'
        })
      )
    } finally {
      setRepairLoading(false)
    }
  }

  return (
    <ConfigSettingsStack>
      <ConfigSwitchRow
        label="允许飞书远程会话使用"
        hint="开启后，飞书 Bot 远程指令可使用 browser 访问网页；默认关闭以降低远程滥用风险。"
        checked={browser.allowRemoteSessions}
        onChange={(v) => patch({ allowRemoteSessions: v })}
      />
      {detect && !detect.canInitialize ? (
        <Alert
          type="warning"
          showIcon
          className="config-alert--compact"
          message="浏览器依赖未就绪"
          description={detect.errors[0] ?? '请点击下方按钮在对话中完成修复。'}
        />
      ) : null}

      <div className="browser-detect-section">
        <div className="browser-detect-section__header">
          <span className="config-field__label">运行环境检测</span>
          <Tooltip title={detect ? '重新检测' : '检测依赖'}>
            <SaIconButton
              size="sm"
              className={detecting ? 'browser-detect-section__refresh--loading' : undefined}
              disabled={detecting}
              aria-label={detect ? '重新检测' : '检测依赖'}
              onClick={() => refresh(true)}
            >
              <span dangerouslySetInnerHTML={{ __html: refreshSvg }} />
            </SaIconButton>
          </Tooltip>
        </div>
        {detect ? (
          <BrowserDetectStatusSummary detect={detect} detecting={detecting}>
            {!detect.canInitialize ? (
              <Button type="primary" block loading={repairLoading} onClick={() => void handleRepairInChat()}>
                帮我修复
              </Button>
            ) : null}
          </BrowserDetectStatusSummary>
        ) : null}
      </div>

      <section className="browser-engine-section">
        <h3 className="config-section-title">操作引擎（Stagehand）</h3>
        <ConfigSettingsStack className="browser-engine-section__body">
          <ConfigField label="操作引擎使用的大模型">
            <Select
              className="config-stagehand-model-select"
              allowClear
              placeholder="留空则复用当前 LLM 模型（自动转为 provider/模型名）"
              value={browser.stagehandModel || undefined}
              onChange={(v) => patch({ stagehandModel: v ?? '' })}
              classNames={configModalModelSelectPopupClassNames}
              options={stagehandModels.map((m) => ({ value: m.name, label: m.name }))}
              optionRender={(opt) => {
                const m = stagehandModels.find((x) => x.name === opt.value)
                return m ? <ConfigModelOptionContent m={m} compact /> : opt.label
              }}
              labelRender={(item) => {
                const m = stagehandModels.find((x) => x.name === item.value)
                return m ? <ConfigModelOptionContent m={m} compact selected /> : item.label
              }}
            />
          </ConfigField>
          <ConfigField label="单次请求最大推理次数">
            <Select
              value={browser.maxInferencesPerRequest}
              onChange={(v) => patch({ maxInferencesPerRequest: v })}
              classNames={configModalSelectPopupClassNames}
              options={[2, 4, 6, 8, 12, 16].map((n) => ({ value: n, label: String(n) }))}
            />
          </ConfigField>
        </ConfigSettingsStack>
      </section>

      <ConfigField
        label="可信域名"
        hint="列表内免确认；其余首次聊天确认，同会话不再问。"
      >
        <Select
          mode="tags"
          placeholder="例：example.com"
          value={browser.trustedDomains}
          onChange={(v) => patch({ trustedDomains: v })}
          classNames={configModalSelectPopupClassNames}
        />
      </ConfigField>

      <ConfigSwitchRow
        label="允许 HTTP"
        hint="关闭后只允许访问 https 链接。"
        checked={browser.allowHttp}
        onChange={(v) => patch({ allowHttp: v })}
      />

      <ConfigSwitchRow
        label="无头模式"
        hint="开启不弹窗后台运行，关闭可见浏览器操作。"
        checked={browser.headless}
        onChange={(v) => patch({ headless: v })}
      />

      <ConfigField label="操作超时（秒）">
        <Select
          value={browser.actionTimeoutSec}
          onChange={(v) => patch({ actionTimeoutSec: v })}
          classNames={configModalSelectPopupClassNames}
          options={[30, 60, 90, 120, 180].map((n) => ({ value: n, label: String(n) }))}
        />
      </ConfigField>

      <ConfigField label="空闲自动关闭浏览器组件，释放内存（秒）">
        <Select
          value={browser.idleTimeoutSec}
          onChange={(v) => patch({ idleTimeoutSec: v })}
          classNames={configModalSelectPopupClassNames}
          options={[600, 1200, 1800, 3600].map((n) => ({ value: n, label: String(n) }))}
        />
      </ConfigField>

      <ConfigField label="禁用操作">
        <Select
          mode="multiple"
          placeholder="选择要禁用的 browser action"
          value={browser.deniedActions}
          onChange={(v) => patch({ deniedActions: v })}
          classNames={configModalSelectPopupClassNames}
          options={['navigate', 'observe', 'extract', 'act', 'screenshot', 'close'].map((a) => ({
            value: a,
            label: a
          }))}
        />
      </ConfigField>
    </ConfigSettingsStack>
  )
}
