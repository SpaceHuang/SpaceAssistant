# 评审：browser-playwright-install-guide-requirement.md

**文档版本：** 1.0
**评审日期：** 2026-05-28
**评审人：** AI Code Review
**文档作者：** 待补充（文档中未声明作者）

---

## 一、总体评价

文档结构完整、条理清晰，背景分析详实，差距识别准确。核心方案（`primaryFailure` 细分、分场景引导、对话内引导）对解决当前用户体验痛点有直接帮助。

**但存在若干过度设计和边缘场景过度工程化的问题**，主要集中在 P1/Phase 2+ 范围，以及部分"通用可扩展框架"设计。MVP 范围如果按当前文档实施，复杂度偏高，有拖慢交付的风险。

---

## 二、核心方案评估（合理部分）

### 2.1 `primaryFailure` 细分（合理）

将 `chromium_missing`、`chromium_headless_only`、`chromium_path_unresolved` 等分离，是**必要的精细化**。现状中检测结果笼统，打包用户看到 `npm install` 命令会产生困惑。分清楚才能引导正确。

### 2.2 `recommendedCwd` 区分开发/打包模式（合理）

打包用户不知道要在"哪个目录"执行 `npx playwright install chromium`。明确告知 `app.getAppPath()` 对应的目录（应用安装位置），解决了 G2 差距。这一设计是文档中**最有价值的改进点**之一。

### 2.3 对话内引导优先（合理）

用户失败后被踢到设置页，体验断裂。让 Agent 在聊天中引导安装，用户无需离开上下文，这是正确的产品方向。

### 2.4 故障排除分 Win/Mac（必要）

Gatekeeper 和 Defender SmartScreen 拦截是完全不同的两道槛，用户需要平台相关的指导。

---

## 三、过度设计问题

### 3.1 「应用内一键安装」（P1）——建议推迟或降为 P2

**问题：** §10 描述了一整套应用内安装能力：`browser:install-chromium` IPC、进度推送 `browser:install-progress`、Confirm 对话、重复安装拒绝。

**为什么是过度设计：**
1. MVP 用户**完全可以在终端完成**安装（复制命令已经提供）。应用内安装并不比"复制命令 → 打开终端 → 粘贴执行"更省步数。
2. 实现这套机制需要：子进程管理、进度事件推送、错误处理、路径白名单验证——代码量不小，且有安全风险（spawn 进程）。
3. §9.3 的「在终端中打开」已经解决了"快速打开正确目录"的问题，应用内安装的增量价值有限。

**建议：** MVP 删除此功能，保留"复制命令 + 在终端打开"。Phase 2 视用户反馈再定。

### 3.2 探针启动（P1，轻度过度）

§6.3 DET-07 和 `init_probe_failed`：在检测通过后**尝试实际启动 Chromium**，失败才报 `init_probe_failed`。

**问题：**
- 这是一个"防御性"检查，Chromium 能解析路径不代表能启动（文档自己也提到了 F4-F7 的运行时失败场景）。但这些运行时失败（安全软件、端口冲突）恰恰是**启动后**才能发现的，检测阶段探针无法完全覆盖。
- 探针本身会引入额外耗时（最长可能接近 15s），影响用户体验。
- 检测阶段能做的最佳验证：**路径存在 + 非 headless_shell + 文件可执行权限**，足够了。

**建议：** `init_probe_failed` 码可保留（为未来探针预留），但 MVP **不实现探针逻辑**，让 `canInitialize` 回归：仅依赖路径检测。

### 3.3 依赖恢复 Hook 注册表（框架过度超前）

§11.1 定义了 `dependencyRecoveryHooks: Record<string, string>`，将 `chromium_missing` → `browser-setup-guide` 映射做成通用注册表，文档还规划了 Phase 4"通用依赖恢复框架"。

**问题：**
- 当前 Hook 只服务于 `browser` 工具这一个场景。Phase 4 的"任意工具可注册"是合理的演进方向，但**现在不需要为这个框架付出设计成本**。
- 实际实现中，直接在 `browserExecutor` 里 `if (errorCode === 'chromium_missing') triggerBrowserSetupGuide()` 比维护一个全局注册表**更简单也更直接**。
- "可扩展"是假性需求——未来新依赖场景的需求还不明确，现在设计通用框架是预支复杂度。

**建议：** MVP 直接硬编码 `chromium_*` → Skill 触发逻辑。通用 Hook 注册表作为 Phase 4（或更远的未来）重新评审。

### 3.4 `hostNpxAvailable` 检测（P1，轻度边缘）

DET-08：检测主机 `npx -v` 是否可用，写入 `hostNpxAvailable`。

**问题：**
- Electron 主进程的 Node 和用户终端的 Node 是**两套独立环境**。主进程能调 `npx` 不代表用户终端能调（PATH 不同、proxy 不同）。
- 但更重要的是：**这个信息对用户引导有什么意义？** 文档没有说清楚。打包用户如果 `npx` 不可用（极端罕见），他能做什么？文档没有给出对应的引导路径。
- 这是一个"收集了但不知道怎么用"的数据。

**建议：** 删 DET-08。如果未来发现用户终端 npm/npx 普遍有问题，应该用**用户手动选择终端类型**（PowerShell/cmd/bash）这种更直接的方式来解决。

### 3.5 验收标准中的部分边缘项

§14.3 中：
- `"复制诊断信息"按钮`：需要额外实现诊断信息收集和脱敏逻辑，但文档没有定义诊断信息格式。这是实现细节遗漏，但更像是一个**非必要的加分项**。
- `"检测通过后 Agent 能感知 dependencyResolved: true 并重试原任务"`：方案 A（Skill 返回 `dependencyResolved: true`）依赖 Agent 主动检查这个字段并重试，是一个隐式协议。如果 Agent 没有特别处理这个字段，重试逻辑可能不生效。**这是一个需要 Agent 行为配合的设计假设**，不是纯前端/后端能控制的事情。

**建议：** 这两项在 MVP 中标注为"可选"，明确依赖 Agent 侧的配合。

---

## 四、方案完整性问题

### 4.1 `recommendedCwd` 在打包模式下的具体值不明确

文档说"打包模式为 `app.getAppPath()` 或资源目录"，但没有说清楚 `app.getAppPath()` 在 Windows/macOS 的具体路径示例。用户可能在权限受限目录（如 Program Files）执行 `npx`，导致失败。

**建议：** 补充 Windows/macOS 打包后 `recommendedCwd` 的**实际路径示例**（如 `C:\Users\<user>\AppData\Local\Programs\SpaceAssistant\resources\app.asar` 或类似），并说明如果目录无写权限的 fallback 策略。

### 4.2 §8.7 Agent 自动重试依赖 Agent 侧实现

方案 A 说"Skill 返回 `dependencyResolved: true`，Agent 自行决定重试"，但没有说明：
- Skill 输出的格式（是工具返回，还是消息？）
- Agent 需要多智能才能理解这个信号并自动重试
- 如果 Agent 不理解这个信号，用户体验是什么

**建议：** 明确这是"依赖 Skill 和 Agent 配合的实验性特性"，MVP 可降为"Skill 引导完成后提示用户手动重试"。

### 4.3 OQ-3 企业离线环境 —— 缺乏最简解法

文档在非目标中提到"离线环境"是 OQ，但没有给出 MVP 可接受的过渡方案。

**建议：** 即使不实现"导入本地 Chromium"，也应该在故障排除中告知用户如何**手动指定路径**（通过 PLAYWRIGHT_BROWSERS_PATH 环境变量），这是一个文档层面的解法，不需要代码实现。

---

## 五、架构设计评审

### 5.1 检测逻辑与 UI 逻辑的边界

§11 定义了 IPC 通道和数据结构，但**没有明确定义"谁负责分场景渲染"**：
- `primaryFailure` 由主进程返回
- 但"展示哪一套引导"（§7.3）是主进程决定还是渲染进程决定？

**建议：** 明确 `BrowserDetectResult` 包含渲染所需的全部信息（`primaryFailure`、`installContext`、`recommendedCwd`），渲染进程**只负责按 `primaryFailure` 渲染对应卡片**，不做检测逻辑判断。

### 5.2 新增 IPC `browser:open-terminal` 的权限风险

§9.3 "在终端中打开"需要 spawn shell 命令。如果 `recommendedCwd` 是用户可控路径（理论上恶意网页可以诱导），存在路径注入风险。

**建议：** 主进程对 `recommendedCwd` 做白名单校验（只能是 `app.getAppPath()` 或项目根），不接受渲染进程传入的自定义路径。

---

## 六、总结与建议

### 6.1 建议裁剪的 MVP 范围

| 内容 | 当前优先级 | 建议 | 理由 |
|------|-----------|------|------|
| §10 应用内一键安装 | P1 | **删除 MVP** | 复制命令+打开终端已够用 |
| DET-07 探针启动 | P1 | **不实现**，但保留 failureCode | 探针无法覆盖运行时失败场景 |
| DET-08 npx 可用性检测 | P1 | **删除** | 信息无对应引导路径 |
| §11.1 通用 Hook 注册表 | P0（架构相关） | **简化为硬编码** | Phase 4 通用框架超前 |
| `hostNpxAvailable` 字段 | P1 | **删除** | 无实际用途 |

### 6.2 建议保留的 MVP 核心

- `BrowserDetectResult` 扩展（`chromium.ready`、`primaryFailure`、`recommendedCwd`、`installContext`）
- 设置页分场景引导（不展示多余的 npm install）
- 对话内引导（Skill + 引导卡片）
- Win/Mac 终端命令分支
- 故障排除折叠区

### 6.3 需要补充的内容

1. `recommendedCwd` 在 Win/Mac 打包模式下的**具体路径示例**
2. Agent 自动重试的**明确协议**（或降为"手动重试"）
3. §8.3 触发 Skill 的**具体实现位置**（`toolChatLoop` 已有，但 Skill 如何渲染到聊天区没有说明——这是 Skill 机制的设计空白）

---

## 七、最终评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 需求完整性 | 8/10 | 背景、差距、场景、跨平台覆盖全面 |
| 方案合理性 | 7/10 | 核心方向正确，部分设计过度 |
| 可执行性 | 6/10 | P1 范围偏大，部分细节缺失 |
| 文档质量 | 8/10 | 结构清晰，文案规范 |

**综合：核心思路值得肯定，但 MVP 范围建议收紧到检测 + 设置页引导 + 对话内引导（不含应用内安装、探针、通用 Hook 框架）。**
