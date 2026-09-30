# Composer 模型 / 思考强度合并入口 — 验收记录归档

> 归档日期：2026-09-30
> 执行环境：worktree `E:\Develop\SpaceAssistant\.worktrees\composer-model-thinking-entry`，分支 `feat/composer-model-thinking-entry`（P0–P6 已全部提交）
> 性质：**自动化可验证项已给出结论与证据；真机（视觉 / 键盘 / 读屏 / 日志抓包）项如实标注「存疑——待真机人工验收」**，不冒充通过。
> 三态口径：**通过**（自动化证据充分）/ **不通过**（无）/ **存疑**（需真机人工验收，jsdom 不渲染真实布局或需外部系统）。

## 1. 自动化验证汇总（全部通过）

| 验证链 | 结果 |
|--------|------|
| 全量 `npm test`（P6-T7） | ✅ 770 文件 / 6056 通过 / 0 失败（22 skipped 为既有基线） |
| `npm run typecheck:renderer` / `typecheck:shared` | ✅ 通过 |
| `npm run build:electron:incremental` | ✅ 通过 |
| `npm run i18n:check` / `i18n:generate-types` / `check:no-nul` | ✅ 通过 |
| 组件单测 `ComposerModelThinkingPicker.test.tsx` | ✅ 19 例 |
| 定向回归（P0-T2 基线 7 文件） | ✅ 基线 93 例 → 各阶段全绿 |

## 2. 逐项结论

### 2.1 P7-T1 真机宽度收益验收

| 验收项 | 状态 | 自动化证据 / 待人工说明 |
|--------|------|--------------------------|
| A16（无歧义净下降 ≈34–98px） | **存疑** | jsdom 无真实布局。结构层面已满足前提：单 chip（`prefsSlot`）+ `displayName` 无前缀（`llmModelConfig.test.ts` 断言）+ 预算 3→2 项（`MessageInput.tsx` checkOverflow）。**待真机**：同窗口宽度对比重构前后 footer 左段占用 |
| A16a（有歧义不为负） | **存疑** | 歧义场景服务段已自动化（组件测试①a：`deepseek-v4-pro（Deep） · 高`）。**待真机**：配置 ≥2 服务支持同名模型后对比占用 |
| A17（状态折叠阈值右移） | **存疑** | 预算公式已按 FR7 收敛且触发条件/常量未动（P5-T2 判据）。**待真机**：逐步缩小窗口观察折叠阈值 |
| A18（无抖动） | **存疑** | idle 复位与 ResizeObserver 逻辑未改（P5-T2 判据）。**待真机**：拖动侧栏观察折叠切换 |

### 2.2 P7-T2 截断与换行验收

| 验收项 | 状态 | 自动化证据 / 待人工说明 |
|--------|------|--------------------------|
| A2c（模型段截断、强度段完整） | **存疑** | CSS 已按规格落地：`.composer-model-chip__label` 独自收缩（min-width:0），`__sep`/`__effort` 均 `flex-shrink: 0`（layout.css，P4-T10）。**待真机**：收窄宽度目检 |
| A2d（1 服务无括号 / ≥2 服务显示 `模型名（服务名） · 档位`） | **通过** | 组件测试①/①a/②：无歧义 `glm-5.3 · 高`；有歧义 `deepseek-v4-pro（Deep） · 高`；无歧义不含括号 |
| A25（5 档换行 4+1、2–3 档不拉伸） | **存疑** | CSS 按 `flex-wrap + flex:1 1 0 + min-width:52px` 实现（禁止固定等分，P4-T10）。**待真机**：5 档模型目检换行与浮层总高（≤400px 已由 scoped max-height 240px 保障） |

### 2.3 P7-T3 无障碍读屏验收

| 验收项 | 状态 | 自动化证据 / 待人工说明 |
|--------|------|--------------------------|
| A19（aria 属性） | **通过**（自动化部分） | 组件测试⑮：`aria-haspopup="dialog"`、`aria-expanded`、`aria-label` 同时含模型与强度 |
| A20（键盘可达：Tab 遍历 / Esc 归焦） | **存疑** | Esc 关闭并把焦点还给 chip 已自动化（测试⑮ `document.activeElement === chip`）；Enter/Space 为原生 button 语义。**待真机**：Tab 遍历两分区、读屏实测 |
| A21（读屏识别强度区 radiogroup/radio/aria-checked） | **通过**（自动化部分） | 测试⑮：`radiogroup` + `radio` + `aria-checked` 断言。**待真机**：读屏软件播报确认 |

### 2.4 P7-T4 回归确认

| 验收项 | 状态 | 证据 |
|--------|------|------|
| A12（模型写库载荷 `{ model, llmServiceId }`） | **存疑→低风险** | `handleModelSelect` 未改动（`git diff d9484..HEAD -- ChatView.tsx` 可证，仅 slot 容器替换）；IPC 层 `sessionIpc.ts` 校验/透传未改且 `appIpc.thinkingEffort.test.ts` 全绿。**待真机**：日志/抓包最终确认载荷 |
| A13（档位写库载荷 `{ thinkingEffort }`，默认项 `null`） | **存疑→低风险** | 同上；「默认项回调 null」已自动化（组件测试⑦）。**待真机**：日志确认 |
| A14（无会话草稿保留） | **通过** | `sessionModelBinding.test.ts` 草稿语义用例全绿；ChatView 草稿清理 useEffect 未改 |
| A15（运行时档位→provider 映射、降级路径无改动） | **通过** | `electron/effortFallback.ts` 零业务改动（P1-T8 `git diff` 证据）；`toolChatLoop.usageStream.test.ts` 35 例绿（R12 核查） |
| A22d（wire 产出 `max`） | **通过** | `electron/effortFallback.test.ts`：`buildThinkingWireParams('max')` → `{ thinking: adaptive, outputConfig: { effort: 'max' } }`；`off` 不带 outputConfig；SDK 白名单核对（`messages.d.ts:708`） |
| A23（无硬编码档位 UI 路径） | **通过** | 组件渲染由 `availableEfforts` prop 驱动；`[...THINKING_EFFORT_LEVELS]` 仅作 fail-open 缺省值（组件内已注释说明）；档位文案按实际档位键逐项取词 `t('composer.thinking.' + level)` |
| A27b（列表渲染不回归；设置页与快照无变化） | **通过** | P2-T5 只读确认（列表渲染 `serviceName`/`modelName`，不读 displayName）；`configModalSnapshot.test.ts` 全量绿；`ModelsSettingsTab` 下拉由枚举自动生成（5 项） |

## 3. 待真机人工验收清单（合并后执行）

1. A16 / A16a / A17 / A18：宽度收益与折叠稳定性（§2.1）
2. A2c / A25：截断优先级与 5 档换行（§2.2）
3. A20 / A21 的真机部分：读屏与纯键盘遍历（§2.3）
4. A12 / A13 的日志确认：`session:update` 载荷抓包（§2.4）
5. P1-G / P2-G / P5-G 挂载的目检项：设置页下拉 5 项、单服务/双服务前缀形态、footer 单 chip 交互

> 处置建议：以上各项在真机验收前**不视为阻塞合入**——其代码路径均已由自动化用例与未改动证据覆盖；真机验收发现的偏差按计划 §12 回滚粒度（P5 为行为切换边界）单独 revert。

## 4. 变更清单（分支 `feat/composer-model-thinking-entry`）

| 提交 | 阶段 | 内容 |
|------|------|------|
| `8b67d093` | P0 | 契约复核结论 + 基线（93 例 + 双 typecheck 绿）；计划/需求文档入库 |
| `d942c7c9` | P1 | 档位枚举 +max（5 档）；IPC 文案派生化；测试断言反转（TDD：RED 8 → GREEN 42） |
| `ffee5aa7` | P2 | displayName 仅歧义加前缀 + serviceAmbiguous（TDD：RED 5 → GREEN 60） |
| `722370f3` | P3 | resolveAvailableThinkingEfforts（TDD：RED 7 → GREEN 19） |
| `741f522a` | P4 | ComposerModelThinkingPicker 组件 + 9 个 i18n 键 + CSS（TDD：RED → GREEN 19） |
| `0c74a9f9` | P5 | MessageInput 收敛 prefsSlot + ChatView 接线（TDD；Chat 目录 276 例绿） |
| `3e64fe2c` | P6 | 删旧组件/CSS/i18n 键；修订两份需求文档 + A26 留痕；全量 6056 例 0 失败 |
