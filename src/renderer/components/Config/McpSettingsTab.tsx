import { useCallback, useEffect, useRef, useState } from 'react'
import { App, Button, Drawer, Empty, Modal, Spin } from 'antd'
import { Plus } from 'lucide-react'
import { MCP_MAX_SERVERS, type McpServerProfile, type McpToolCacheEntry } from '../../../shared/mcpTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import {
  draftToWriteInput,
  initMcpServerDraft,
  isMcpDraftDirty,
  newMcpServerDraft,
  type McpServerDraft
} from './mcpDrafts'
import { McpServerCard } from './McpServerCard'
import { McpServerForm } from './McpServerForm'

export type McpSettingsTabProps = {
  /** 当前是否为 MCP 分区（用于离开分区时的草稿丢弃确认）。 */
  active?: boolean
  /** 设置页是否打开。 */
  open?: boolean
}

export function McpSettingsTab({ active = true, open = true }: McpSettingsTabProps) {
  const { modal, message } = App.useApp()
  const { t } = useTypedTranslation('mcp')
  const [loading, setLoading] = useState(false)
  const [servers, setServers] = useState<McpServerProfile[]>([])
  const [drafts, setDrafts] = useState<McpServerDraft[]>([])
  const [toolCaches, setToolCaches] = useState<Record<string, McpToolCacheEntry>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [oauthStartingId, setOauthStartingId] = useState<string | null>(null)
  const [diagnosticsServer, setDiagnosticsServer] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<Array<{ code: string; message: string; occurredAt: string }>>([])
  const dirtyRef = useRef(false)
  const prevActiveRef = useRef(active)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const config = await window.api.mcpList()
      setServers(config.servers)
      setToolCaches(config.toolCaches ?? {})
      setDrafts(config.servers.map(initMcpServerDraft))
      dirtyRef.current = false
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // 离开 MCP 分区且有未保存草稿时提示确认
  useEffect(() => {
    if (prevActiveRef.current && !active && dirtyRef.current) {
      modal.confirm({
        title: t('messages.discardTitle'),
        content: t('messages.discardContent'),
        okText: t('messages.discardOk'),
        cancelText: t('messages.discardCancel'),
        onOk: () => {
          dirtyRef.current = false
        }
      })
    }
    prevActiveRef.current = active
  }, [active, modal, t])

  const patchDraft = useCallback((id: string, patch: Partial<McpServerDraft>) => {
    setDrafts((current) => current.map((d) => (d.id === id ? { ...d, ...patch } : d)))
    dirtyRef.current = true
  }, [])

  /** 启用服务时自动把已发现工具全部加入白名单，降低逐个勾选负担。 */
  const toggleServerEnabled = useCallback((id: string, checked: boolean, toolNames: string[]) => {
    setDrafts((current) =>
      current.map((d) =>
        d.id === id
          ? {
              ...d,
              enabled: checked,
              ...(checked
                ? { enabledToolNames: [...new Set([...d.enabledToolNames, ...toolNames])] }
                : {})
            }
          : d
      )
    )
    dirtyRef.current = true
  }, [])

  const addServer = useCallback(() => {
    if (drafts.length >= MCP_MAX_SERVERS) {
      message.warning(t('maxServers', { max: MCP_MAX_SERVERS }))
      return
    }
    const draft = newMcpServerDraft()
    setDrafts((current) => [...current, draft])
    dirtyRef.current = true
    setEditingId(draft.id)
  }, [drafts.length, message, t])

  const saveServer = useCallback(
    async (id: string) => {
      if (drafts.some((d) => !d.name.trim())) {
        message.warning(t('form.nameRequired'))
        return
      }
      setSavingId(id)
      try {
        const result = await window.api.mcpSaveProfiles({
          servers: drafts.map(draftToWriteInput)
        })
        setServers(result.servers)
        setDrafts(result.servers.map(initMcpServerDraft))
        dirtyRef.current = false
        message.success(t('messages.saved'))
        setEditingId(null)
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error))
      } finally {
        setSavingId(null)
      }
    },
    [drafts, message, t]
  )

  const testServer = useCallback(
    async (id: string) => {
      const draft = drafts.find((d) => d.id === id)
      if (!draft) return
      if (!draft.name.trim()) {
        message.warning(t('form.nameRequired'))
        return
      }
      setTestingId(id)
      try {
        const result = await window.api.mcpTestConnection({
          server: draftToWriteInput(draft)
        })
        if (result.ok) {
          setToolCaches((current) => ({
            ...current,
            [id]: {
              tools: result.tools,
              protocolVersion: result.protocolVersion,
              discoveredAt: new Date().toISOString()
            }
          }))
          message.success(t('messages.testOk', { count: result.tools.length }))
        } else {
          message.error(t('messages.testFailed', { message: result.message }))
        }
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error))
      } finally {
        setTestingId(null)
      }
    },
    [drafts, message, t]
  )

  const refreshServer = useCallback(
    async (id: string) => {
      setRefreshingId(id)
      try {
        const result = await window.api.mcpRefreshTools({ serverId: id })
        if (result.ok) {
          setToolCaches((current) => ({
            ...current,
            [id]: {
              tools: result.tools,
              protocolVersion: current[id]?.protocolVersion ?? '',
              discoveredAt: new Date().toISOString()
            }
          }))
          message.success(t('messages.testOk', { count: result.tools.length }))
        } else {
          message.error(t('messages.testFailed', { message: result.message }))
        }
        await load()
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error))
      } finally {
        setRefreshingId(null)
      }
    },
    [load, message, t]
  )

  const closeEditor = useCallback(() => {
    if (!editingId) return
    const draft = drafts.find((d) => d.id === editingId)
    const profile = servers.find((s) => s.id === editingId)
    if (draft && isMcpDraftDirty(profile, draft)) {
      modal.confirm({
        title: t('messages.discardTitle'),
        content: t('messages.discardContent'),
        okText: t('messages.discardOk'),
        cancelText: t('messages.discardCancel'),
        onOk: () => {
          dirtyRef.current = false
          setEditingId(null)
        }
      })
      return
    }
    setEditingId(null)
  }, [drafts, editingId, modal, servers, t])

  const deleteServer = useCallback(
    (id: string) => {
      const draft = drafts.find((d) => d.id === id)
      modal.confirm({
        title: t('card.deleteTitle'),
        content: t('card.deleteContent', { name: draft?.name || id }),
        okType: 'danger',
        onOk: async () => {
          await window.api.mcpDeleteServer({ serverId: id })
          message.success(t('messages.deleted'))
          await load()
        }
      })
    },
    [drafts, load, message, modal, t]
  )

  const clearSecret = useCallback(
    (id: string) => {
      const draft = drafts.find((d) => d.id === id)
      const kind = draft?.auth.mode === 'custom-header' ? 'auth-header' : 'access-token'
      modal.confirm({
        title: t('card.clearTokenTitle'),
        content: t('card.clearTokenContent'),
        onOk: async () => {
          await window.api.mcpClearSecret({ serverId: id, kind })
          message.success(t('messages.tokenCleared'))
          await load()
        }
      })
    },
    [drafts, load, message, modal, t]
  )

  const openDiagnostics = useCallback(async (id: string) => {
    const result = await window.api.mcpGetDiagnostics({ serverId: id })
    setDiagnostics(result.diagnostics)
    setDiagnosticsServer(id)
  }, [])

  const oauthStart = useCallback(
    async (id: string) => {
      setOauthStartingId(id)
      try {
        const result = await window.api.mcpOauthStart({ serverId: id })
        if (result.ok) {
          message.success(t('messages.oauthStarted'))
        } else {
          message.error(t('messages.oauthFailed', { message: result.message }))
        }
        await load()
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error))
      } finally {
        setOauthStartingId(null)
      }
    },
    [load, message, t]
  )

  const clearDiagnostics = useCallback(async () => {
    if (!diagnosticsServer) return
    await window.api.mcpClearDiagnostics({ serverId: diagnosticsServer })
    setDiagnostics([])
  }, [diagnosticsServer])

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
        <Spin />
      </div>
    )
  }

  const editingDraft = drafts.find((d) => d.id === editingId)
  const editingProfile = servers.find((s) => s.id === editingId)
  const editingCache = editingId ? toolCaches[editingId] : undefined
  const editingIsNew = editingDraft ? !servers.some((s) => s.id === editingDraft.id) : false

  return (
    <div className="mcp-settings-tab" style={{ display: active ? undefined : 'none' }}>
      <div className="mcp-settings-tab__header">
        <div className="mcp-settings-tab__heading">
          <h2 className="mcp-settings-tab__title">{t('title')}</h2>
          <p className="mcp-settings-tab__intro">{t('intro')}</p>
        </div>
        {drafts.length > 0 ? (
          <Button type="dashed" icon={<Plus size={14} />} onClick={addServer}>
            {t('addServer')}
          </Button>
        ) : null}
      </div>
      {drafts.length === 0 ? (
        <div className="mcp-settings-empty">
          <Button type="primary" size="large" icon={<Plus size={16} />} onClick={addServer}>
            {t('addServer')}
          </Button>
        </div>
      ) : null}
      <div className="mcp-server-list">
        {drafts.map((draft) => {
          const profile = servers.find((s) => s.id === draft.id)
          const cache = toolCaches[draft.id]
          const tools = cache?.tools ?? []
          const canEnable = tools.length > 0
          return (
            <McpServerCard
              key={draft.id}
              draft={draft}
              profile={profile}
              tools={tools}
              refreshing={refreshingId === draft.id}
              oauthStarting={oauthStartingId === draft.id}
              dirty={isMcpDraftDirty(profile, draft)}
              canEnable={canEnable}
              toolsStale={cache?.stale}
              onEdit={() => setEditingId(draft.id)}
              onRefresh={() => void refreshServer(draft.id)}
              onDelete={() => deleteServer(draft.id)}
              onClearSecret={() => clearSecret(draft.id)}
              onOpenDiagnostics={() => void openDiagnostics(draft.id)}
              onOauthStart={() => void oauthStart(draft.id)}
              onToggleEnabled={(checked) =>
                toggleServerEnabled(
                  draft.id,
                  checked,
                  tools.map((t) => t.originalName)
                )
              }
            />
          )
        })}
      </div>

      <Modal
        className="mcp-server-edit-modal"
        open={editingId !== null}
        title={editingIsNew ? t('addServer') : t('card.editServer')}
        onCancel={closeEditor}
        width={720}
        footer={null}
      >
        {editingDraft ? (
          <McpServerForm
            draft={editingDraft}
            profile={editingProfile}
            tools={editingCache?.tools ?? []}
            skippedCount={editingCache?.skippedCount ?? 0}
            testing={testingId === editingDraft.id}
            saving={savingId === editingDraft.id}
            canEnable={(editingCache?.tools.length ?? 0) > 0}
            onPatch={(patch) => patchDraft(editingDraft.id, patch)}
            onTest={() => void testServer(editingDraft.id)}
            onSave={() => void saveServer(editingDraft.id)}
            onToggleEnabled={(checked) =>
              toggleServerEnabled(
                editingDraft.id,
                checked,
                (editingCache?.tools ?? []).map((t) => t.originalName)
              )
            }
          />
        ) : null}
      </Modal>

      <Drawer
        title={t('form.diagnosticsTitle')}
        className="mcp-diagnostics-drawer"
        open={diagnosticsServer !== null}
        onClose={() => setDiagnosticsServer(null)}
        width={480}
        extra={
          <Button size="small" onClick={() => void clearDiagnostics()}>
            {t('form.clearDiagnostics')}
          </Button>
        }
      >
        {diagnostics.length === 0 ? (
          <Empty description={t('form.diagnosticsEmpty')} />
        ) : (
          <div className="mcp-diagnostics-list">
            {diagnostics.map((entry) => (
              <div key={entry.occurredAt + entry.code} className="mcp-diagnostics-entry">
                <code>{entry.code}</code>
                <pre>{entry.message}</pre>
              </div>
            ))}
          </div>
        )}
      </Drawer>
    </div>
  )
}
