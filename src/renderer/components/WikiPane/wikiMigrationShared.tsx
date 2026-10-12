import './wikiMigrationShared.css'

/**
 * Wiki 迁移系列界面的共享视觉件：旧根 chips / 报告摘要 / 冲突清单。
 * WikiPane 侧栏（横幅 + 向导 + 报告）与设置页 WikiTab（迁移弹窗）共用，保证两处渲染一致。
 */

/** 旧 Wiki 根的安静 chip 列表（暖灰底、meta 字号；完整目录名走 title）。 */
export function LegacyRootChips({ roots }: { roots: ReadonlyArray<string> }) {
  if (roots.length === 0) return null
  return (
    <div className="wiki-migration-chips">
      {roots.map((root) => (
        <span key={root} className="wiki-migration-chip" title={root}>
          {root}
        </span>
      ))}
    </div>
  )
}

/** 迁移失败项清单（报告可见性：failed profile 不再静默——2026-10-11 实机回归教训）。 */
export function MigrationFailureSection({
  title,
  failures
}: {
  title: string
  failures: ReadonlyArray<{ workDir?: string; rootDirName?: string; error?: string }>
}) {
  if (failures.length === 0) return null
  return (
    <div className="wiki-migration-conflicts">
      <p className="wiki-migration-conflicts-title">{title}</p>
      <div className="wiki-migration-conflict-rows">
        {failures.map((failure) => (
          <div key={`${failure.workDir}-${failure.rootDirName}`} className="wiki-migration-conflict-row">
            <div className="wiki-migration-failure-texts">
              <code className="wiki-migration-conflict-path">
                {`${failure.workDir ?? ''} → ${failure.rootDirName ?? ''}`}
              </code>
              {failure.error ? <span className="wiki-migration-failure-error">{failure.error}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 迁移报告摘要行（secondary 语气）。 */
export function MigrationSummary({ text }: { text: string }) {
  return <p className="wiki-migration-summary">{text}</p>
}

/** 冲突双保留清单：标题 + mono 路径行（bg-subtle 底），路径是数据本身，等宽字体是语义需要。 */
export function MigrationConflictSection({
  title,
  conflicts
}: {
  title: string
  conflicts: ReadonlyArray<{ path: string; keptAs: string }> | undefined
}) {
  if (!conflicts || conflicts.length === 0) return null
  return (
    <div className="wiki-migration-conflicts">
      <p className="wiki-migration-conflicts-title">{title}</p>
      <div className="wiki-migration-conflict-rows">
        {conflicts.map((conflict) => (
          <div key={`${conflict.path}-${conflict.keptAs}`} className="wiki-migration-conflict-row">
            <code className="wiki-migration-conflict-path">{conflict.path}</code>
            <span className="wiki-migration-conflict-arrow" aria-hidden="true">
              →
            </span>
            <code className="wiki-migration-conflict-path">{conflict.keptAs}</code>
          </div>
        ))}
      </div>
    </div>
  )
}
