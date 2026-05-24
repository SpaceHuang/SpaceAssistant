import { Spin } from 'antd'

export function PlanPanelDraftingBar() {
  return (
    <div className="plan-panel-drafting-bar">
      <Spin size="small" />
      <span>正在探索并生成计划…</span>
    </div>
  )
}
