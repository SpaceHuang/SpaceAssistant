# 交互设计指南：来源与维护附录

> **本文件服务于方法审计、修订与追溯。日常设计任务不需要加载本文**——读 [`interaction-design-guide.md`](interaction-design-guide.md) 正文即可。
> 分工见 [`document-writing-guide.md`](document-writing-guide.md) §1：正文只放动作；来源映射、迁移记录、局限与维护规则放在本文件。

## 归纳口径

**本版（v0.2）覆盖三类**：确认与打断（I1–I5）、设置项与开关（I6–I7）——证据来自 `docs/review/` 的需求类评审 36 篇（约 13 个独立主题）中与交互相关的部分；**新增界面准入（I8）**——证据来自一个"合规则加戏"的实践案例（见下节"新增界面准入（I8）的来源"）。其余交互主题尚无抽样证据，正文不为它们写规则；未覆盖清单见本文件末尾"未覆盖主题"一节。

纳入标准同前两篇：具备可复现依据、后续修复 / 关闭记录，或跨主题重复出现。

## 迁移记录（2026-10-16）

- 本指南 §1 的 I1–I5 **原为《需求写作指南》§4（R7–R11，五条）**。复核发现那节写的是"交互该是什么样"（设计规范），而非"需求文档该怎么写"（写作规范），属串层；且整套指南只此一节涉及交互，读者定位混乱。
- 抽取时同时做了归属筛选，**删掉两条实现层要求**：
  1. "确认必须绑定最终执行对象"（含"先定最终目标再确认"、对象摘要绑定、绕过检查）→ 属技术方案规格层；交互层只保留用户可感知的"提示与执行一致"（现 I4 第 1 条）。
  2. "询问文案必须给出可照抄格式、且格式在需求中定稿"→ 属编解码 / 接口实现；交互层只保留"用户能明确指向所批准的那一件"（现 I4 第 3 条）。
- 《需求写作指南》§4 改为指针节：涉及交互的条款按本指南取值，需求里只写**本需求的取值**，不写判据推导。

## 各条来源映射

- **I1（触发条件）** ← `explicit-output-directory-candidate-requirement-second-review` P0-1（触发条件从"归属会产生影响"改为"**存在两个以上合理归属，且不同归属会产生用户可感知的重要差异**"；并给出"意图明确→默认且只在结果展示""真歧义→首次写入前询问""用途一致的一组文件一次确认"三条体验）与 P0-2（路径类型判定顺序，末条为"只询问这一件事，不得靠扩展名强猜，也不得先创建再让用户纠正"）；`explicit-output-directory-candidate-requirement-review` P0-5（何时可自行判断、何时必须让用户纠正）。
- **I2（粒度与频率）** ← 同文 P0-3（四种"目标已存在"情形混同）与 P1-4（"首次"指每会话 / 每工作区 / 每次检测未定义）；`…-second-review` P0-1（一组文件一次确认）及其"通过项"（持续编辑同一成果不重复确认）。
- **I3（四条路径）** ← `…-second-review` P0-3（"用户拒绝创建草稿后任务如何继续"必须写明，不能只写"不创建文件"）；`…-fourth-review` P0-1（"先问工作包 / 先问暂存 / 直接暂存"三选一必须定；取消后不产生文件）。
- **I4（批准语义）** ← `file-viewer-markdown-export-docx-pdf-requirement-review` 第 2 项（用户确认 `方案.txt`、实际覆盖 `方案.pdf` → 取"提示与执行不一致"这一用户可感知事实）；`2026-10-08-remote-im-async-approval-security-requirement-review` 第 3 项（一次性追认被默认升级为长期授权；"记住"必须独立、事前明确并展示范围 / 有效期 / 撤销方式）与第 5 项（多待办时回复必须唯一指向，含糊文本不得消费）。
- **I5（默认与成本）** ← `explicit-output …-fourth-review` P0-1（并列默认会派生三种不同体验，不能留给设计）；`remote-private-chat-security-optimization-requirement-review` §2.1（"须在实现前选定（开放决策）"，未定则实现分叉）与 §2.2（单独回复"信任"即写入授权列表，误触面大于显式短语）；`2026-10-08-remote-im-async-approval-security-requirement-review` 第 3 项（授权疲劳被列为安全风险）。

## Impeccable 的落地信息（2026-10-16 记录）

- **来源**：外部 skill `pbakaus/impeccable`，声明在 `skills-lock.json`（`skills.impeccable`，技能路径 `.agents/skills/impeccable/SKILL.md`，带 `computedHash` 用于版本锁定）。
- **仓库内安装与状态**：`.claude/skills/impeccable/`（技能本体）；`.impeccable/config.local.json`（hook 授权）；`.impeccable/hook.cache.json`（按会话记录被编辑文件的 `editCount` 与 `findings`）。
- **`findings` 的实际形态**：`design-system-color:<行号>:<值>`、`design-system-radius:<行号>:<值>`、`design-system-font-size:<行号>:<值>` —— 即**绕过设计系统（token）的硬编码**；对已确认无问题的文件记 `cleanAcked: true`。
- **实战先例（正文 §2 判据的来源）**：`docs/develop/archive/desktop-ui/composer-plus-menu-development-plan.md` P3-T5「使用 Impeccable 审查并优化新增界面」，其中给出"加载项目视觉上下文与 Operate 场景参考 → 有范围审查 → 按发现修正 → 复查同一状态集合"的完整完成判据；该阶段关闭条件包含"Impeccable 审查及优化证据已记录"。
- **局限**：hook 只覆盖被它跟踪、且含视觉值的文件（缓存里可见主进程文件如 `electron/ipc/fileIpc.ts` 同样会命中，不限于渲染层组件）；设计规范基线（token 清单）本身需要项目维护；它不替代无障碍与安全评审。

## 设置项与开关（I6–I7）的来源与证据

- **首要来源**：使用者实践原则（多次观察到 Agent 在实现过程中自行新增设置开关），2026-10-16 记录。
- **评审侧证据**（把"新增开关 / 配置项"当作需要克制的行为）：
  - [`remote-security-analysis-review.md`](../review/remote-security-analysis-review.md):211 —— 既有全局开关 `autoAllowScriptExecution` 可跳过确认，评审要求**收敛**其语义，而不是进一步默认放行；
  - [`im-architecture-refactor-review.md`](../review/im-architecture-refactor-review.md):94 —— 需要 per-channel 差异时"需回退或增加『覆盖通用设置』开关"，被记为风险；
  - [`2026-10-08-remote-im-async-approval-security-requirement-review.md`](../review/2026-10-08-remote-im-async-approval-security-requirement-review.md):38 —— "设置开关不能独自替代本次授权范围的明确表达"；
  - [`explicit-output-directory-candidate-requirement-review.md`](../review/explicit-output-directory-candidate-requirement-review.md):134 —— 建议按用户价值排序，"而不是继续增加容器或配置项"。
- **现状规模（开关成本的现实背景）**：`src/renderer/components/Config/` 下约 20 个设置页与表单（`ToolsSecuritySettingsTab.tsx` 34KB、`SkillsTab.tsx` 30KB、`McpServerForm.tsx` 22KB 等）。
- **局限**：本条来自使用者原则与实践观察；"用户偏好是否真的分叉"没有量化数据；**审批载体（谁批、批在哪个记录里）需要团队约定**，指南只规定"必须取得明确审批"。
- **修订记录（2026-10-16）**：初稿的 I7 曾给"时间紧"开口子（"先按最合适的默认实现，并在交付说明里标注此处应为默认"）。经复核**删除该例外**：交互设计是需求 / 设计阶段的上游工作，不存在来不及确认的情形；"排不开"属排期问题，正确处理是推迟该能力、保持默认实现，而不是先斩后奏。同时在正文 §0 增加第 3 条前提"规则没有应急例外"。

## 新增界面准入（I8）的来源（2026-10-16）

- **来源**：一个"每一步都合规则"的加戏案例复盘（"AGENTS.md 支持"），证据链：
  - 需求 `docs/requirement/archive/agent-sdk/agents-md-workdir-instructions-requirement.md`：新增界面被写成"状态与可观测性"（FR-06，文档中部），并声明"其余推荐默认值是评审基线，不代表用户已确认全部产品取舍"——**界面要求以"推荐值"身份通过**；
  - 方案 `docs/develop/archive/agent-sdk/agents-md-workdir-instructions-development-plan.md`：放大为"设置开关与请求级状态 UI / IPC"阶段（8 个任务全 `[x]`，阶段提交 `fe50f237`），需求追踪矩阵把 FR-06 改名"UI / IPC / IM 状态 / 隐私"并标 PASS；
  - 评审：需求评审只处理"只读展示 vs 可执行恢复"的语义歧义，方案评审只留 B01/B02——**两处都未覆盖界面归属**；
  - 实现：界面形态由写代码的 Agent 决定（`src/renderer/components/Chat/ProjectInstructionsControl.tsx`，134 行、antd `Collapse/Popover/Switch/Tag`、13 种状态、自拟 i18n），落在**聊天区**而不是设置体系。
- **判据**：呈现层管"组件与样式怎么写"，行为层管"何时问 / 默认值 / 开关"，**"要不要加界面、放哪个入口"没有主人** → 默认落到 Agent。I8 补的就是这个位置：界面额度与形态由**项目负责人**批。
- **与 I6/I7 的分工**：I6/I7 管"开关该不该加"；I8 管"界面该不该加、加在哪、长什么样"。两者可同时触发。
- **强度**：与 I7 同级——**无例外**，不接受"先实现、界面待评审"。
- **局限**：只有单案例证据；"界面归属卡"的五行是否够用，需要在下一批涉及界面的需求上验证。

## 未覆盖主题（v0.2 待办；新增规则前先补证据）

以下主题**尚无抽样证据**，因此正文不写规则（这是维护者待办，不是给设计者的内容）：

- 反馈与状态呈现：进行中、失败、可恢复状态分别怎么表达（**注：I8 只管"要不要新增界面、放在哪个入口"，不覆盖"状态怎么表达"，本条待办仍然成立**）；
- 可撤销与可解释：用户事后能否解释"刚才发生了什么"，撤销的边界在哪；
- 不可逆操作的提示与二次确认；
- 跨渠道交互一致性（桌面 / IM / 远程请求）；
- 首次使用与引导。

新增任一主题前，先回 `docs/review` 抽样取证（对照使用者实践），**不要凭直觉写**。

## 局限

1. **覆盖面窄**：正文覆盖"确认与打断""设置项开关""新增界面准入"三类；其余见上节待办。
2. 依据强度不均：I1、I3、I4 有明确正反例；I2、I5 偏定性；**I8 为单案例证据**。
3. 未做用户实测（例如打断次数是否真的可接受），目前只有评审层的判断。
4. 不替代 `AGENTS.md`「UI 规范」的组件 / 样式约定，也不替代无障碍与安全评审。

## 维护规则

1. 新增主题（见上文"未覆盖主题"一节）前，先回 `docs/review` 抽样取证；没有证据的主题不写规则。
2. 新增规则前先过 §0 的判定句（第 1、2 条）：删掉它用户是否有感？同一描述能否导出两种实现？
3. 若与《需求写作指南》或《技术方案写作指南》出现冲突，先判断是"层归属错误"还是"规则写错"，再决定改哪一篇——**同一条规则只在一处定义**。
4. 规则被新证据推翻时，先更新正文，再在本文件记录结论变化与证据。
