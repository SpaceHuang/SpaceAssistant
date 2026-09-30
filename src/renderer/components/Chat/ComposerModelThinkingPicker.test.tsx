import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { AppConfig } from '../../../shared/domainTypes'
import type { AgentReasoningEffort } from '../../../shared/agent/invocation'
import { normalizeModelEntry } from '../../../shared/llmModelConfig'
import { ComposerModelThinkingPicker } from './ComposerModelThinkingPicker'

function makeCfg(options: { services?: Array<{ id: string; name: string; supportedModelIds: string[] }> } = {}): AppConfig {
  const models = [
    normalizeModelEntry({ id: '1', name: 'deepseek-v4-pro' }),
    normalizeModelEntry({ id: '2', name: 'glm-5.3', isFast: true }),
    normalizeModelEntry({ id: '3', name: 'kimi-k2.7-code', isVision: true })
  ]
  const services = options.services ?? [
    { id: 's1', name: 'Deep', supportedModelIds: ['1', '2'] },
    { id: 's2', name: 'Volcano', supportedModelIds: ['1', '3'] }
  ]
  return {
    locale: 'zh-CN',
    apiKeyPresent: true,
    baseUrl: '',
    llmServices: services.map((s) => ({ ...s, baseUrl: '', apiKeyPresent: true })),
    activeLlmServiceId: services[0]?.id,
    activeLlmServiceIds: services.map((s) => s.id),
    model: 'glm-5.3',
    defaultModel: 'glm-5.3',
    models,
    thinkingEnabled: true,
    workDir: '/tmp',
    workDirProfiles: [],
    activeWorkDirProfileId: 'default',
    maxParallelChatSessions: 3,
    tools: { enabled: true, deniedTools: [], allowedTools: [], pythonPath: 'python', scriptTimeout: 300, fileCheckpointingEnabled: true, maxFileSnapshots: 100, grepTimeoutSec: 60 },
    skills: { routing: { mode: 'llm', enabled: true, model: '', timeoutMs: 15000, includeTriggersInCatalog: false }, alwaysLoad: [] },
    wiki: { enabled: false, rootPath: 'llm-wiki' },
    feishu: { enabled: false },
    browser: { enabled: true, trustedDomains: [], allowedDomains: [] },
    shell: { enabled: true, trustedCommands: [] }
  } as AppConfig
}

type PickerProps = React.ComponentProps<typeof ComposerModelThinkingPicker>

const ALL_EFFORTS: AgentReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max']

function renderPicker(overrides: Partial<PickerProps> = {}) {
  const onSelectModel = vi.fn()
  const onSelectEffort = vi.fn()
  const view = render(
    <ComposerModelThinkingPicker
      cfg={makeCfg()}
      modelName="glm-5.3"
      modelDisplayName="glm-5.3"
      onSelectModel={onSelectModel}
      effort="high"
      effortOverridden={true}
      globalEffort="medium"
      onSelectEffort={onSelectEffort}
      availableEfforts={ALL_EFFORTS}
      {...overrides}
    />
  )
  const chip = screen.getByRole('button', { name: /模型与思考强度/ })
  return { onSelectModel, onSelectEffort, chip, unmount: () => view.unmount(), rerender: view.rerender }
}

function openPopover(chip: HTMLElement): void {
  fireEvent.click(chip)
}

describe('ComposerModelThinkingPicker（FR1/2/3/5/6/8/9/10）', () => {
  it('① 收起态 chip：模型名 + 当前档位词（无歧义，FR3）', () => {
    const { chip } = renderPicker({ modelName: 'glm-5.3', modelDisplayName: 'glm-5.3' })
    expect(chip.textContent).toBe('glm-5.3 · 高')
  })

  it('①a 有歧义时服务段以全角括号紧随模型段（FR3：不用 · 作服务分隔）', () => {
    const { chip } = renderPicker({
      modelName: 'deepseek-v4-pro',
      modelServiceName: 'Deep',
      modelDisplayName: 'Deep-deepseek-v4-pro'
    })
    expect(chip.textContent).toBe('deepseek-v4-pro（Deep） · 高')
  })

  it('①b en-US modelServiceSuffix 无尾空格：与 chipSeparator 拼接不产生双倍间距（R14/P4-T0）', async () => {
    const enChat = (await import('../../i18n/resources/en-US/chat.json')).default as {
      composer: { prefs: { modelServiceSuffix: string; chipSeparator: string } }
    }
    const suffix = enChat.composer.prefs.modelServiceSuffix
    // en-US 值不得带尾空格——否则与 chipSeparator（前导空格）叠加成双倍间距
    expect(suffix.endsWith(' ')).toBe(false)
    const composed = `kimi-k2.7-code${suffix.replace('{{service}}', 'Volcano')}${enChat.composer.prefs.chipSeparator}高`
    expect(composed).not.toMatch(/\S\s{2,}\S/)
  })

  it('② 无歧义时不出现括号（FR3：不留空括号）', () => {
    const { chip } = renderPicker()
    expect(chip.textContent).not.toContain('（')
    expect(chip.textContent).not.toContain('）')
  })

  it('③ 打开后同时渲染模型分区与强度分区（含两个分区标题，FR2/A6）', () => {
    const { chip } = renderPicker()
    openPopover(chip)
    expect(screen.getByText('模型')).not.toBeNull()
    expect(screen.getByText('思考强度')).not.toBeNull()
    expect(screen.getAllByRole('radio').length).toBe(5)
    // fixture:deepseek-v4-pro 被 s1/s2 双服务支持(歧义用例)→ 2 项 + glm-5.3 + kimi = 4 项
    expect(screen.getAllByRole('option').length).toBe(4)
  })

  it('④ 模型项含模型名 + 服务名副文案 + 徽章（FR2/A7）', () => {
    const { chip } = renderPicker()
    openPopover(chip)
    const visionItem = screen.getByRole('option', { name: /kimi-k2.7-code/ })
    expect(visionItem.textContent).toContain('Volcano')
    expect(visionItem.textContent).toContain('视觉')
    const fastItem = screen.getByRole('option', { name: /glm-5.3/ })
    expect(fastItem.textContent).toContain('快速')
  })

  it('⑤ 档位项数等于传入的 availableEfforts（FR10/A8：不固定 4 档）', () => {
    const { chip } = renderPicker({ availableEfforts: ['off', 'high'] })
    openPopover(chip)
    expect(screen.getAllByRole('radio').length).toBe(2)
  })

  it('⑥ 「· 默认」标记与选中态正确（A8：未覆盖时默认槽选中；覆盖后选中切到覆盖档位）', () => {
    // 未覆盖：默认槽（= globalEffort）选中
    const first = renderPicker({ effort: 'medium', effortOverridden: false, globalEffort: 'medium' })
    openPopover(first.chip)
    const defaultItem = screen.getByRole('radio', { name: '中 · 默认' })
    expect(defaultItem.getAttribute('aria-checked')).toBe('true')
    first.unmount()
    // 覆盖 high：high 选中，默认槽不选中
    const second = renderPicker({ effort: 'high', effortOverridden: true, globalEffort: 'medium' })
    openPopover(second.chip)
    expect(screen.getByRole('radio', { name: '高' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: '中 · 默认' }).getAttribute('aria-checked')).toBe('false')
  })

  it('⑦ 点「X · 默认」回调 null；点其余档位回调对应值（A9）', () => {
    const { chip, onSelectEffort } = renderPicker({ effort: 'low', effortOverridden: true, globalEffort: 'medium' })
    openPopover(chip)
    fireEvent.click(screen.getByRole('radio', { name: '中 · 默认' }))
    expect(onSelectEffort).toHaveBeenCalledWith(null)
    openPopover(chip)
    fireEvent.click(screen.getByRole('radio', { name: '高' }))
    expect(onSelectEffort).toHaveBeenCalledWith('high')
  })

  it('⑧ 选中模型 / 档位后浮层立即关闭（FR2 末/OQ-4/A9a）', () => {
    const { chip, onSelectModel } = renderPicker()
    openPopover(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('option', { name: /glm-5.3/ }))
    expect(onSelectModel).toHaveBeenCalled()
    expect(chip.getAttribute('aria-expanded')).toBe('false')

    openPopover(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: '高' }))
    expect(chip.getAttribute('aria-expanded')).toBe('false')
  })

  it('⑨ effortDisabled：chip 仍可打开、模型列表仍可选，仅强度分区禁用并显示原因（FR6/A10）', () => {
    const { chip, onSelectEffort } = renderPicker({
      effortDisabled: true,
      effortDisabledReason: '该模型不支持 Thinking'
    })
    // chip 本身不禁用
    expect((chip as HTMLButtonElement).disabled).toBe(false)
    openPopover(chip)
    // 模型列表仍可选
    fireEvent.click(screen.getByRole('option', { name: /kimi-k2.7-code/ }))
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    // 强度分区禁用
    openPopover(chip)
    for (const radio of screen.getAllByRole('radio')) {
      expect((radio as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getByText('该模型不支持 Thinking')).not.toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: '高' }))
    expect(onSelectEffort).not.toHaveBeenCalled()
  })

  it('⑩ 空池：模型分区空态文案、强度分区仍可用（FR6/A5）', () => {
    const { chip, onSelectEffort } = renderPicker({
      cfg: makeCfg({ services: [] }),
      modelName: '',
      modelDisplayName: ''
    })
    openPopover(chip)
    expect(screen.getByText('暂无可用模型，请前往设置配置 API 服务与模型')).not.toBeNull()
    const radios = screen.getAllByRole('radio')
    expect(radios.length).toBe(5)
    expect((radios[0] as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: '中 · 默认' }))
    expect(onSelectEffort).toHaveBeenCalledWith(null)
  })

  it('⑪ 传 2 项集合只渲染 2 项；不传 = 全 5 项（FR10 fail-open/A22）', () => {
    const two = renderPicker({ availableEfforts: ['off', 'high'] })
    openPopover(two.chip)
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['关闭', '高'])
    two.unmount()

    const fallback = renderPicker({ availableEfforts: undefined })
    openPopover(fallback.chip)
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['关闭', '低', '中 · 默认', '高', '最高'])
  })

  it('⑫ 传入含 max 的集合 → 渲染「最高」并按 max 回调（A22c/A22d）', () => {
    const { chip, onSelectEffort } = renderPicker({ effort: 'low', effortOverridden: true })
    openPopover(chip)
    const maxItem = screen.getByRole('radio', { name: '最高' })
    expect(maxItem).not.toBeNull()
    fireEvent.click(maxItem)
    expect(onSelectEffort).toHaveBeenCalledWith('max')
  })

  it('⑬ 继承与覆盖两态 chip 都只显示档位词（无「默认（中）」括注，FR3/A2a）', () => {
    const inherited = renderPicker({ effort: 'medium', effortOverridden: false, globalEffort: 'medium' })
    expect(inherited.chip.textContent).toBe('glm-5.3 · 中')
    inherited.unmount()
    const overridden = renderPicker({ effort: 'low', effortOverridden: true, globalEffort: 'medium' })
    expect(overridden.chip.textContent).toBe('glm-5.3 · 低')
  })

  it('⑭ 档位切换后 chip 强度段即时更新（A2b：rerender 传新 effort）', () => {
    const props: PickerProps = {
      cfg: makeCfg(),
      modelName: 'glm-5.3',
      modelDisplayName: 'glm-5.3',
      onSelectModel: vi.fn(),
      effort: 'high',
      effortOverridden: true,
      globalEffort: 'medium',
      onSelectEffort: vi.fn(),
      availableEfforts: ALL_EFFORTS
    }
    const view = render(<ComposerModelThinkingPicker {...props} />)
    const chip = screen.getByRole('button', { name: /模型与思考强度/ })
    expect(chip.textContent).toBe('glm-5.3 · 高')
    view.rerender(<ComposerModelThinkingPicker {...props} effort="max" />)
    expect(chip.textContent).toBe('glm-5.3 · 最高')
  })

  it('⑮ aria 属性与角色正确（FR8/A19/A21）', () => {
    const { chip } = renderPicker({ modelName: 'glm-5.3', modelServiceName: 'Deep', modelDisplayName: 'glm-5.3' })
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    // aria-label 同时描述模型与强度
    expect(chip.getAttribute('aria-label')).toContain('glm-5.3')
    expect(chip.getAttribute('aria-label')).toContain('高')

    openPopover(chip)
    const group = screen.getByRole('radiogroup')
    expect(group).not.toBeNull()
    // radio + aria-checked
    const checked = screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')
    expect(checked.map((r) => r.textContent)).toEqual(['高'])
    // 模型分区 listbox/option 语义
    expect(screen.getByRole('listbox')).not.toBeNull()
    // Esc 关闭并把焦点还给 chip
    fireEvent.keyDown(group, { key: 'Escape' })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(chip)
  })

  it('modelUnavailable：chip 带警告类名，title 显示不可用提示，浮层仍可打开（FR6/A4）', () => {
    const { chip } = renderPicker({ modelUnavailable: true })
    expect(chip.className).toContain('composer-model-chip--warn')
    expect(chip.getAttribute('title')).toBe('当前会话模型不可用，请重新选择')
    openPopover(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('option').length).toBe(4)
  })

  it('模型段回退：modelName 为空 → cfg.model → 仍未配置则「未配置模型」（FR3）', () => {
    // modelName 为空但 cfg.model 有值 → 回退到 cfg.model
    const fallbackCfgModel = renderPicker({ cfg: makeCfg({ services: [] }), modelName: '' })
    expect(fallbackCfgModel.chip.textContent).toContain('glm-5.3')
    fallbackCfgModel.unmount()

    // 两者皆空 → 未配置模型
    const emptyCfg = makeCfg({ services: [] })
    emptyCfg.model = ''
    render(
      <ComposerModelThinkingPicker
        cfg={emptyCfg}
        modelName=""
        modelDisplayName=""
        onSelectModel={vi.fn()}
        effort="high"
        effortOverridden={true}
        globalEffort="medium"
        onSelectEffort={vi.fn()}
        availableEfforts={ALL_EFFORTS}
      />
    )
    expect(screen.getByRole('button', { name: /模型与思考强度/ }).textContent).toContain('未配置模型')
  })
})
