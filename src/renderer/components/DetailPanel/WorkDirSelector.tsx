import { useCallback, useMemo, useRef } from 'react'
import { App, Select } from 'antd'
import { ChevronDown } from 'lucide-react'
import { useAppDispatch, useTypedSelector } from '../../hooks'
import { setConfig, openSettings } from '../../store/configSlice'
import { setSession, setChatStatus } from '../../store/chatSlice'
import { setSessions } from '../../store/sessionSlice'
import type { WorkDirProfile } from '../../../shared/feishuTypes'
import { useDetailPanel } from './DetailPanelContext'
import { runtimeText } from '../../i18n/runtimeText'

function profileLabel(profile: Pick<WorkDirProfile, 'name' | 'path'>): string {
  const trimmed = profile.name.trim()
  if (trimmed) return trimmed
  const base = profile.path.replace(/\\/g, '/').split('/').filter(Boolean).pop()
  return base ?? profile.path
}

type Props = {
  disabled?: boolean
}

export function WorkDirSelector({ disabled }: Props) {
  const { message } = App.useApp()
  const dispatch = useAppDispatch()
  const { closeFile } = useDetailPanel()
  const cfg = useTypedSelector((s) => s.config.config)
  const chatStatus = useTypedSelector((s) => s.chat.chatStatus)
  const runningSessions = useTypedSelector((s) => s.chat.runningSessions)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const profiles = cfg?.workDirProfiles ?? []
  const activeId = cfg?.activeWorkDirProfileId ?? profiles.find((p) => p.isDefault)?.id ?? ''

  const isStreaming = useMemo(() => {
    if (chatStatus === 'streaming' || chatStatus === 'sending') return true
    return Object.values(runningSessions).some((r) => r.status === 'streaming')
  }, [chatStatus, runningSessions])

  const options = useMemo(
    () =>
      profiles.map((p) => ({
        value: p.id,
        label: profileLabel(p)
      })),
    [profiles]
  )

  const handleOpenSettings = useCallback(() => {
    dispatch(openSettings({ tab: 'general' }))
  }, [dispatch])

  const handleSwitch = useCallback(
    (profileId: string) => {
      if (profileId === activeId) return
      if (isStreaming || disabled) {
        message.warning(runtimeText('detailPanel.waitForSession'))
        return
      }
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        void (async () => {
          const result = await window.api.workdirSwitch(profileId)
          if (!result.success) {
            message.error(result.error ?? runtimeText('detailPanel.switchFailed'))
            return
          }
          const nextConfig = await window.api.configGet()
          dispatch(setConfig(nextConfig))
          dispatch(setSessions(result.sessions))
          dispatch(setSession(null))
          dispatch(setChatStatus({ status: 'idle' }))
          closeFile()
        })()
      }, 300)
    },
    [activeId, closeFile, disabled, dispatch, isStreaming, message]
  )

  if (profiles.length === 0) {
    return (
      <button
        type="button"
        className="workdir-selector-empty"
        onClick={() => dispatch(openSettings({ tab: 'general' }))}
      >
        {runtimeText('detailPanel.configureWorkDirFirst')}
      </button>
    )
  }

  return (
    <Select
      className="workdir-selector"
      size="small"
      value={activeId || undefined}
      options={options}
      disabled={disabled}
      popupMatchSelectWidth={false}
      classNames={{ popup: { root: 'workdir-selector-popup' } }}
      onChange={handleSwitch}
      popupRender={(menu) => (
        <>
          {menu}
          <div className="workdir-selector-popup-footer">
            <button
              type="button"
              className="workdir-selector-settings-action"
              onClick={handleOpenSettings}
            >
              {runtimeText('detailPanel.setWorkDir')}
            </button>
          </div>
        </>
      )}
      aria-label={runtimeText('detailPanel.switchWorkDir')}
      title={runtimeText('detailPanel.switchWorkDir')}
      suffixIcon={<ChevronDown size={14} strokeWidth={2} aria-hidden />}
    />
  )
}
