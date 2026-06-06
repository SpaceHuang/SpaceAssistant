import { useCallback, useMemo, useRef } from 'react'
import { App, Select } from 'antd'
import { ChevronDown } from 'lucide-react'
import { useAppDispatch, useTypedSelector } from '../../hooks'
import { setConfig, openSettings } from '../../store/configSlice'
import { setSession, setChatStatus } from '../../store/chatSlice'
import { setSessions } from '../../store/sessionSlice'
import type { WorkDirProfile } from '../../../shared/feishuTypes'

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
        message.warning('当前会话正在响应，请等待完成后再切换')
        return
      }
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        void (async () => {
          const result = await window.api.workdirSwitch(profileId)
          if (!result.success) {
            message.error(result.error ?? '切换失败')
            return
          }
          const nextConfig = await window.api.configGet()
          dispatch(setConfig(nextConfig))
          dispatch(setSessions(result.sessions))
          dispatch(setSession(null))
          dispatch(setChatStatus({ status: 'idle' }))
        })()
      }, 300)
    },
    [activeId, disabled, dispatch, isStreaming, message]
  )

  if (profiles.length === 0) {
    return (
      <button
        type="button"
        className="workdir-selector-empty"
        onClick={() => dispatch(openSettings({ tab: 'general' }))}
      >
        请先配置工作目录
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
              设置工作目录...
            </button>
          </div>
        </>
      )}
      aria-label="切换工作目录"
      title="切换工作目录"
      suffixIcon={<ChevronDown size={14} strokeWidth={2} aria-hidden />}
    />
  )
}
