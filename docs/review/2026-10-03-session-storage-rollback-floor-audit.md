# Phase 5.5 rollback floor audit

## Decision

**No-go for stopping legacy body writes or clearing `messages.content`.** The currently published `v0.2.2` tag is not a compatible rollback target. A compatible rollback release has not been built or published, and physical cleanup must remain locked until that release is verified.

This is a compatibility audit package, not approval to perform cleanup.

## Evidence

- Published tag `v0.2.2` declares database schema version 19 (`electron/database/schema.ts`). The current worktree declares schema version 46 and includes additive session-content state, eligibility, spill-GC, History invalidation, transcript-cache checksum, persisted write-stopped cleanup-state, completed-cleanup-ledger immutability, canonical-only body immutability, and global History allocator integrity migrations.
- `v0.2.2` has no `electron/runtime/sessionTranscriptProjection.ts` or `electron/runtime/sessionContentWriteAuthority.ts`. Its user-facing message reads in `electron/database/operations.ts` select `messages.content` directly, including `getMessages`, `getTurnContext`, sequence paging, and route-window reads.
- Current `electron/database/migrations.ts` rejects a database whose schema version is newer than the binary supports. A v0.2.2 rollback against the current schema-46 profile therefore fails before opening the application. If that version guard were bypassed, the old readers would still return empty bodies for rows already cleared by Phase 5.5.
- Current Phase 5.4 retains legacy bodies and dual writes. That keeps the present database content readable by a compatible older build only while those copies remain intact; it does not make v0.2.2 a rollback target after a future clear.

## Minimum compatible rollback release

Before any legacy body is cleared, publish and preserve a rollback build that:

1. Opens the exact schema version written by the cleanup release without downgrading or rewriting the database schema.
2. Understands `content_storage_state='canonical-backed-only'` and reads each such body through the canonical History projection with spill checksum validation and fail-closed behavior.
3. Covers every production body consumer needed after rollback, including transcript/chat, API context, turn routing and `reuse-user`, search, export/backup, retry, and recovery.
4. Does not repopulate cleared legacy bodies from stale mirrors, and preserves all control metadata, queue/turn state, attachment references, and preview invariants.
5. Has a kill switch or documented recovery path that returns to the preserved legacy copies before cleanup begins; after cleanup, rollback is limited to the compatible release floor.

## Required release-floor verification

Use a disposable copy of a real file-backed database at the exact cleanup-release schema (currently schema 46) with representative canonical-backed-only rows, multi-spill bodies, cache hit/miss states, queued messages, active/terminal turns, and backup/restore artifacts. Include a paired and an unpaired global History allocator cursor so the rollback floor verifies v46 cursor-integrity handling as well as transcript reads. Verify that the proposed floor build opens it, reads the canonical bodies after process restart, rejects missing/corrupt History or spill without returning empty content, and leaves the original profile untouched. Record the exact release identifier, schema version, test fixture, and result. The release must be published and retained before the first cleanup batch; a worktree, unmerged branch, or local build is not a release floor.

## Gate status

| Gate | Status |
| --- | --- |
| Current published rollback target compatibility | **Failed** (`v0.2.2`, schema 19; canonical-only reader absent) |
| Compatible rollback build | **Unique v0.2.3 local candidate DMGs built and smoke-tested; formal R release not published** |
| Cleanup authorization | **Locked** |

This gate is separate from the search-budget review and from the completed source-truth spill GC lifecycle. Neither of those changes makes the current published binary compatible with cleared `messages.content`.

## Local R candidate package preflight (2026-10-04)

This is local artifact evidence for the candidate commit below. It does not change the No-go decision or establish a published rollback floor.

- Candidate commit: `9f9faa1d4cec0848f1ee7f507e1f67e80add0b21` (`fix(test): build local provider package before test suite`). The commit is present on `codex/session-storage-refactor-tdd`, not merged or tagged.
- Clean detached checkout: `/tmp/session-storage-refactor-r-candidate2`; `npm ci` completed. Initial clean-checkout `npm test` exposed that the local provider package `dist/index.js` was missing. Added `pretest` to build that workspace package. A second fresh checkout from the candidate commit then passed focused storage tests (349/349) and the full suite (858 files passed, 1 skipped; 8,110 passed, 106 skipped).
- Clean-checkout checks passed: renderer/shared/agent-sdk typecheck, normal and strict i18n checks, `git diff --check`, and `npm run build`.
- `npm run pack:mac` produced local x64 and arm64 DMGs. Packaging logs show both app bundles passed the repository afterPack resource checks (ripgrep and seven tree-sitter assets) and ad-hoc signing verification. The arm64 bundle also passed `scripts/verify-macos-app-signature.mjs`; the sequential pack script removes the x64 app bundle after its DMG is built. Both disk images passed `hdiutil verify`.
- Local DMG SHA-256: x64 `fe3672d354bf64ff83990766630a3080f08952b5498ce18eb008c9e61b7d4a56`; arm64 `3e00cb5bd56df88197c8d69cf9145a033f48de08421f994ff6eef146a1301d64`.
- The machine has no Developer ID Application identity; these are ad-hoc signed local artifacts, not distribution-signed releases. No release/tag/publication was performed. The required disposable-profile upgrade and actual R→C→R installed-package drill is still outstanding; C is not yet a separate release artifact. Cleanup remains locked.

## Integrated R candidate preflight (2026-10-04, integration commit `76555a46`)

This addendum supersedes the earlier branch-only package preflight for current schema numbering. It remains local development evidence and does not change the No-go decision.

- The isolated integration branch is `codex/session-storage-refactor-integration`; implementation commit `76555a46ebb8f58a2f3d591d9e0cf5d0b02b6ccc` is based on main `78909882`. Main and the original feature branch were not modified. Main's migrations v31–v33 are retained; the refactor migrations continue through schema v49 (cleanup state v48; History cursor integrity v49).
- A detached clean checkout of `76555a46` completed `npm ci`, the full suite (866 files passed/1 skipped; 8,223 passed/106 skipped), shared/renderer/agent-sdk typechecks, normal and strict i18n checks, and `npm run build`. `pretest` built `agent-provider-pi-ai` from the clean checkout.
- `npm run pack:mac` built the x64 app bundle and passed ripgrep/tree-sitter resource checks. The initial afterPack signing attempt failed while disk space was low; after space was freed, the app bundle was ad-hoc signed and `codesign --verify --deep --strict` passed. Electron Builder could not create the DMG: `hdiutil resize` failed with `ENOSPC` (requested temporary image size about 861 MB). No arm64 DMG was produced.
- The machine reports zero valid Developer ID Application identities. The ad-hoc signed `.app` is not a distribution-signed installer. `npm cache clean --force` was attempted to free space but stopped on an EACCES error for a root-owned cache entry; it removed some cache data before stopping.
- No installation, disposable-profile upgrade, R→C→R drill, release, or tag was performed. Current installed rollback floor remains unavailable; cleanup stays locked.

## Local profile migration smoke (2026-10-04, schema 33 → 49)

This is an isolated app-bundle smoke test. The DMG was made directly with `hdiutil` from the ad-hoc signed x64 `.app` because the repository electron-builder DMG step could not allocate its temporary image. It is not the prescribed or distribution-ready R installer.

- The local test image `SpaceAssistant-0.2.2-local-test.dmg` passed `hdiutil verify`; SHA-256: `b1d42c2b3f943759ff21adad05158ada0391b6a5b3ea8cc5c7bccd0c5a10fdd7`.
- Built a disposable file-backed profile with main's schema-v33 database code and one user message (`legacy-body-survives-r-migration`). Started the app from the mounted image twice with `--user-data-dir=/tmp/sa-r-legacy-profile-76555`, never using the installed app's profile.
- After startup and again after restart, schema version was 49; the session/message IDs, sequence 0, status, and legacy body remained intact. The v48 `content_storage_state` column was present. No stop-write or cleanup API was invoked.
- The Mac was locked during the run, so no window-level check was possible. Database evidence proves startup migration and retained-body integrity only; it does not prove a polished install flow, graceful UI shutdown, canonical-only rollback reads, or C→R compatibility.
- The repository `npm run pack:mac`/electron-builder DMG flow remains failed for disk space; no Developer ID exists. No C artifact, release, or tag exists. Gate remains No-go; cleanup remains locked.


## Local v46 clean-checkout candidate package smoke (2026-10-04)

This is stronger local candidate evidence on the TDD branch, but it does not establish a supported rollback floor.

- Fixed source: commit `9f9faa1d4cec0848f1ee7f507e1f67e80add0b21`. Created a new detached clean checkout at `.worktrees/session-storage-r-clean-9f9faa1d`; `npm ci` completed (1,086 packages added; npm audit reported 32 vulnerabilities: 1 low, 10 moderate, 20 high, 1 critical).
- Clean-checkout validation passed: full `npm test -- --reporter=dot` (858 files passed/1 skipped; 8,110 passed/106 skipped), renderer/shared/agent-sdk typechecks, normal and strict i18n (1,154 hardcoded Chinese occurrences, all in tests; 0 in source), and `npm run build`.
- `npm run pack:mac` produced `release/SpaceAssistant-0.2.2.dmg` (198 MiB, SHA-256 `acf3419b9a2300008df476ebc60e7d4286e257ccf57ad7732e2e8a9a0e0f3ea2`) and `release/SpaceAssistant-0.2.2-arm64.dmg` (191 MiB, SHA-256 `d1f301f40dbb979039c35c5bbeac8501ee839723687a757ba50d4e0d0bd6ec88`). Both passed `hdiutil verify`; both app bundles passed ripgrep/tree-sitter resource checks and local ad-hoc signing verification. The machine has no valid Developer ID Application identity. The package metadata still says `0.2.2`, colliding with the already published incompatible `v0.2.2` (schema 19); these files must not be represented as R or distributed.
- Built a disposable file-backed schema-v46 profile with one completed canonical History message, passed the explicit cleanup protocol to `complete`, then closed/reopened. The DB had `content=''`, `content_storage_state='canonical-backed-only'`, `cleanup_state='complete'`, `write_mode='canonical'`, `api_read_mode='legacy'`, `integrity_check=ok`, and no FK violations. Fixture path: `/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/sa-m2-6-candidate-F5O3p7`; session `e2f15c7a-4e04-4175-b51f-fbec5159da8b`.
- Mounted and launched the arm64 DMG read-only against this disposable profile. Startup migration, History classification/recovery, and session-ledger reconcile all logged `ok`. Actual renderer→preload→IPC calls to `chatGetApiContextBaseline`, `chatGetMessagePage`, `chatGetSearchCorpusPage`, and global `searchExecute` returned or hit `canonical body survives restart`. Deleted only the disposable profile's transcript projection L1 row after clean app exit, relaunched the package, and all four reads still returned the same body through History reconstruction.
- Launched the x64 DMG through Rosetta against a second disposable copy. Startup stages logged `ok`; the same four actual packaged IPC consumers returned/hit the canonical body. After exit, both healthy profiles retained an empty legacy body and complete cleanup ledger; integrity checks were `ok`, FK checks empty.
- Fault injection used a separate copy at `/tmp/sa-m2-6-v46-corrupt-history`: after dropping the write-stop delete guard solely in that disposable copy, removed the invocation context event while leaving its terminal event. The mounted arm64 package started and its page, API-context baseline, and search-corpus IPCs each rejected with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`; they did not return empty content. After exit, DB integrity remained `ok`, FK check empty, legacy body stayed empty, cleanup stayed complete/canonical, and no transcript cache was rebuilt.
- Limits: no failed-assistant retry IPC, full model dispatch (write-fenced complete session must not resume), export/JSON restore package round-trip, multi-spill package fixture, damaged-spill package fixture, paired/unpaired allocator corruption matrix, or actual C→R→C installed release drill was run here. Candidate package version collision and absent C/final R artifact prevent release-floor sign-off; production cleanup stays locked.


## Local v0.2.3 versioned candidate package smoke (2026-10-04)

This follow-up resolves the local package version collision recorded in the prior v46 smoke. It remains an unpublished, ad-hoc signed candidate and does not authorize cleanup.

- Fixed source: `09b0e624aeeda0d96fc934f1867374692656f2e6` (`chore(release): set rollback candidate version 0.2.3`). `package.json` and `package-lock.json` both report `0.2.3`; no tag was created. Clean detached checkout: `.worktrees/session-storage-r-clean-0.2.3`.
- `npm ci` completed (1,086 packages added; npm audit reports 32 vulnerabilities: 1 low, 10 moderate, 20 high, 1 critical). Full `npm test -- --reporter=dot`: 858 files passed/1 skipped; 8,110 passed/106 skipped. Renderer/shared/agent-sdk typechecks, normal/strict i18n (1,154 hardcoded Chinese occurrences all in tests, 0 in source), `npm run build`, and `npm run pack:mac` passed.
- Packaged outputs: x64 `release/SpaceAssistant-0.2.3.dmg`, 198 MiB, SHA-256 `0536caee71337976b0aa674ad3279c36570ffbdc309d0fa70769e8dcc26b765c`; arm64 `release/SpaceAssistant-0.2.3-arm64.dmg`, 191 MiB, SHA-256 `746311d4f0daf5b99071b2cbabe34b1ccb887d3e3db249ffa3ba225787ee90b8`. Both passed `hdiutil verify`, afterPack resource checks and local ad-hoc signing verification. This host has no valid Developer ID Application identity, so they are not distribution-signed releases.
- Reused only disposable schema-v46 profile copies. Arm64 startup migration, History classification/recovery, and session-ledger reconciliation logged `ok`; x64 under Rosetta logged the same. On both architecture packages, actual renderer→preload→IPC `chatGetApiContextBaseline`, `chatGetMessagePage`, `chatGetSearchCorpusPage`, and global `searchExecute` returned/hit `canonical body survives restart`.
- On the arm64 profile, after clean app exit deleted the transcript L1 cache row, relaunched v0.2.3, and confirmed all four consumers still returned the canonical body through History reconstruction. A separate corrupted-history profile with its invocation context event removed returned `CANONICAL_SESSION_CONTENT_UNAVAILABLE` from the installed page, API-context, and search-corpus IPCs. Neither path silently returned an empty body.
- Final checks on healthy arm64/x64 and damaged-history profiles: `PRAGMA integrity_check=ok`, foreign-key check empty, `messages.content=''`, `content_storage_state='canonical-backed-only'`, `cleanup_state='complete'`, `write_mode='canonical'`, `api_read_mode='legacy'`; the damaged profile did not recreate a transcript cache.
- The earlier retry fixture's `createPersistedTurn(state='terminal')` was misclassified as active by the cleanup gate, whose terminal allowlist is `completed/failed/cancelled/interrupted`. Corrected the disposable fixture to use `state='failed'` and an `invocation-failed` History terminal, then completed cleanup without bypassing any guards.
- On that protocol-complete profile, the mounted v0.2.3 arm64 renderer's actual `chatResolveRetryContext` IPC returned `failedAssistant.content='failed answer canonical'` and `currentUser.content='retry input canonical'` from History while both SQLite message bodies were empty. No model request was dispatched. After app exit, integrity was `ok`, FK check empty, both storage states remained `canonical-backed-only`, cleanup remained `complete`, and the write/API modes remained `canonical`/`legacy`. Fixture path: `/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/sa-m2-6-retry-UGkXCp`; session `3a2fcc98-1040-4fae-98de-2ccfd6e2daf0`.
- Through the mounted v0.2.3 arm64 package, called `sessionUpdate` on the same complete retry fixture and waited past the production debounce. It wrote `/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/sa-m2-6-retry-UGkXCp/workspace/sessions/3a2fcc98-1040-4fae-98de-2ccfd6e2daf0-20261004/messages.json` (458 bytes; SHA-256 `f06fa0f1bfe31f00140f932811a1264865df59551faffe61a80586928a376868`). The JSON held both canonical-only bodies although SQLite stored them empty. `SessionBackupManager.restoreSession` source roundtrip then restored the same session/message IDs, roles, bodies, and statuses. The app has no renderer restore IPC, so this does not substitute for a full-profile restore drill.
- Still outstanding: multi-spill and damaged-spill package cases, full allocator/owner/watermark corruption matrix, old-profile upgrade, actual C-installed cleanup states, R→C→R/re-upgrade drill, Developer ID signature, main integration, formal tag/release and retained downloadable artifacts. Thus v0.2.3 is only the proposed rollback floor until release process completes; production stop-write/cleanup remains locked.


## Local multi-spill cold-cache and corruption verification (2026-10-04)

- Disposable file-backed schema-v46 profile: `/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/sa-m2-6-spill-v023-iG6N9Z`; one canonical-only session with three 84,029-byte messages, three source-of-truth spill files, `cleanup_state=complete`, `write_mode=canonical`, all three SQLite legacy bodies empty. Each descriptor was validated against byte length and SHA-256.
- After database reopen, `readSessionTranscriptProjection` returned `canonical:L1` and all three full bodies matched the expected prefix and 200-byte tail. In a copied profile with only the transcript cache row deleted, it returned `canonical:L2`; all three full bodies again matched.
- Corruption copy: `/tmp/sa-m2-6-spill-v023-corrupt-1791107698`; changing one byte caused `validateCanonicalSessionSourceTruthSpills` to fail with `SPILL_CONTENT_UNAVAILABLE` and transcript projection to fail closed with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`; it did not return empty/partial transcript. This is source/runtime file-SQLite evidence, not a packaged renderer IPC failure drill.
- The arm64 v0.2.3 candidate window is running in the separate `spaceassistant-dev` profile. UI showed model `deepseek-flash` and a user-started `HI` request still generating during this audit; no model request was initiated by this verification.
- Remaining M2-6 items are the packaged IPC spill-damage drill, allocator/owner/watermark corruption matrix, old-profile upgrade and actual C→R→C installer exercise. Candidate remains unpublished and ad-hoc signed; production stop-write and cleanup remain locked.


## Candidate live terminal display handoff issue (2026-10-04)

- On the running arm64 v0.2.3 candidate, the disposable `spaceassistant-dev` profile received a user-started `HI` request. Persisted state shows one terminal turn with outcome `completed`, the linked assistant message has status `completed` and 340 characters, and History contains `model-response-committed` plus `invocation-completed`. The composer was enabled, while the same live window continued to show the assistant bubble as generating/placeholder for over a minute.
- Gracefully restarted only the candidate app after confirming zero active execution-queue rows. It reopened the same `spaceassistant-dev` profile and rendered the persisted assistant response. The installed `/Applications/SpaceAssistant.app` process/profile was not stopped or modified.
- Result: no persisted transcript loss; a live renderer terminal-display handoff/reconciliation failure is present in the candidate and remains unexplained. This is a user-visible release-floor blocker: candidate smoke must not be described as passing live terminal UI presentation until the event path is diagnosed and regression-verified. No request was sent by the audit; the `HI` call was already present in the candidate profile before the audit read it.


## Renderer recovery guard for orphaned streaming rows (2026-10-04)

- Added a ChatView TDD regression for the observed split state: local assistant row remains `streaming` with partial text after the session stops running, while `chatGetMessagePage` returns the same message ID in `completed` state with the final body. The test failed before the guard (kept the partial streaming row) and passed after.
- ChatView/turn-display related tests: 7 files, 69 tests passed. `npm run typecheck:renderer` and `npm run build:renderer` passed.
- The guard performs a best-effort page read only when a streaming assistant remains after the current session ceases running; it patches only the same message ID and ignores late completion after unmount/session change.
- Started the current TDD worktree dev process against the configured `spaceassistant-dev` profile. Startup database migrations, History classification/recovery, and session ledger reconciliation reported `ok`; no model request was sent. The actual v0.2.3 package remains the pre-fix artifact, so a newly versioned clean-checkout installer still needs live UI verification before M2-6 can close.

## Local v0.2.4 clean-checkout candidate build (2026-10-04)

- Fixed commit: `a17ac8e17e0bb50fe29da079b278c0bcec53adc2` (`chore(release): set rollback candidate version 0.2.4`), package and lockfile version `0.2.4`; detached checkout `.worktrees/session-storage-r-clean-0.2.4` was clean before build.
- `npm ci` succeeded. Full `npm test -- --reporter=dot`: 858 files passed/1 skipped; 8,111 passed/106 skipped. Renderer/shared/agent-sdk typechecks, normal/strict i18n and `npm run build` passed. Strict i18n found 1,155 hardcoded Chinese occurrences, all in tests and zero in source.
- `npm run pack:mac` produced x64 `release/SpaceAssistant-0.2.4.dmg` (198 MiB, SHA-256 `d5a00cdc200cee055406cb9496a4396e08bc57ed6de0af9770fa3d8849efe0fb`) and arm64 `release/SpaceAssistant-0.2.4-arm64.dmg` (191 MiB, SHA-256 `700e398ff9dcac74f7ec9439d4fab29288ca955f2fe9e8b52ae20ae64605e817`). Both passed `hdiutil verify`. Mounted each DMG read-only; app bundle version was 0.2.4, executable architecture matched x64/arm64, and `codesign --verify --deep --strict` passed. Signatures are local ad-hoc only. Developer ID signing is a release policy and is not a functional development gate.
- This verifies clean-checkout build artifacts only. The packaged live terminal assistant UI regression was fixed by TDD in commit `4dbdd1da`, but no v0.2.4 package live UI acceptance, full consumer/fault-injection matrix, old-profile upgrade, C→R→C installer rehearsal, tag/release or retained formal release artifacts have been completed. Developer ID signing and formal release are separate release-policy work. M2-6 remains open; production stop-write and physical cleanup remain locked.

## v0.2.4 arm64 isolated-profile UI smoke (2026-10-04)

- Copied the existing `spaceassistant-dev` profile to `/Users/space/Library/Application Support/SpaceAssistant-v024-smoke`; the source profile remained open under the TDD dev process and was not modified by the candidate.
- Started the v0.2.4 arm64 app from `.worktrees/session-storage-r-clean-0.2.4/release/mac-arm64/SpaceAssistant.app` with `--user-data-dir` pointing at the copy. The existing `HI` session loaded the completed assistant response (same message ID, 340 characters) and the composer was idle. No new user message or model request was sent. The candidate process was quit before inspecting the copied DB.
- Copied profile checks: SQLite `integrity_check=ok`, `foreign_key_check` empty, user row `sent`, assistant row `completed` with 340 characters, linked turn `terminal/completed`. This demonstrates candidate-package startup and restored rendering of the previously stuck conversation after restart. It does not exercise the original in-process terminal handoff race; the deterministic renderer regression remains covered by the ChatView TDD test. The copied profile used the legacy-body path, so this is not canonical-only spill IPC coverage.

## v0.2.4 arm64 canonical-only IPC and History fault smoke (2026-10-04)

- Reused only the prior schema-v46 disposable candidate fixture `sa-m2-6-candidate-F5O3p7`; copied it to `/tmp/sa-v024-canonical-smoke` and then to the isolated app profile `/Users/space/Library/Application Support/SpaceAssistant-v024-canonical-smoke`. Before launch, `messages.content` was empty with `canonical-backed-only`, cutover was `write_mode=canonical`, `cleanup_state=complete`, DB integrity was `ok`, and FK check was empty. Original fixture was not modified.
- Started the actual v0.2.4 arm64 app with `--user-data-dir` and a loopback-only DevTools port. Through the packaged renderer's `window.api` preload surface, actual IPC returned the canonical body `canonical body survives restart` from API-context baseline, message page, and search corpus; global `searchExecute` matched the message. No model request was sent.
- Quit the app, made a second independent profile copy, and injected a History context fault there by dropping the cleanup delete guard and deleting only the context event. The resulting DB retained `integrity_check=ok`, empty FK check, empty legacy message body, canonical-backed-only state, and `cleanup_state=complete`.
- Started the same v0.2.4 arm64 package on the damaged copy. API-context baseline, message-page, search-corpus, and global-search IPCs all rejected with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`; none returned empty/partial content as success. After app exit the damaged profile still had one terminal History event, empty legacy content, and canonical write mode/complete cleanup state.
- This closes a packaged canonical-only healthy read smoke and one History-missing fail-closed case on arm64. It does not cover spill-byte corruption through package IPC, x64 canonical-only, allocator/owner/watermark corruption matrix, old-profile upgrade, or C→R→C technical installation rehearsal. M2-6 remains open; Developer ID and formal publication remain separate release-policy work.

## v0.2.4 x64 canonical-only and multi-spill package IPC (2026-10-04)

- Mounted the actual x64 DMG read-only and ran under Rosetta against a fresh copy of schema-v46 canonical-only fixture `sa-m2-6-candidate-F5O3p7`. Startup took about 70 seconds under Rosetta before the page became available; this was delayed startup, not a test failure. Actual renderer→preload→IPC API-context baseline, message page, search corpus and global search returned/matched `canonical body survives restart`. The copied DB stayed `integrity_check=ok`, FK check empty, legacy body empty, canonical-backed-only, and cleanup complete.
- On the arm64 package, copied the three-message file-backed multi-spill fixture `sa-m2-6-spill-v023-iG6N9Z` into an isolated profile. The DB had three canonical-backed-only rows, each legacy body empty; the profile had three 84,029-byte source-truth spill files, and the L1 transcript cache was absent so package reads reconstructed through History/spill L2. Actual API-context, message-page and search-corpus IPCs each returned all three exact bodies with 84,029 characters; global search for `canonical multi spill body 0` matched `spill-user-0`. No model request was sent. After exit, DB integrity was `ok`, FK check empty, all three legacy bodies stayed empty and cleanup stayed complete.
- Copied that healthy package profile again and changed one byte of the first spill file. On the same arm64 package, API-context, message-page, search-corpus and global-search IPCs all failed with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`. Post-exit DB integrity remained `ok`, FK check empty, all three legacy bodies remained empty, all rows stayed canonical-backed-only, and cleanup remained complete.
- These checks extend M2-6 package evidence across both architectures for canonical-only reads, arm64 multi-spill L2 reconstruction, and arm64 spill-byte corruption fail-closed. Remaining: x64 damaged-History/spill matrix, allocator/owner/watermark corruption cases through required scope, old-profile upgrade, and C→R→C technical installation rehearsal. M2-6 remains open; release signing/publication is not a functional gate.

## v0.2.4 x64 canonical-only package IPC (2026-10-04)

- Mounted `release/SpaceAssistant-0.2.4.dmg` read-only and ran its x64 app under Rosetta against a fresh copy of the schema-v46 canonical-only fixture. First startup took about 70 seconds before DevTools/page readiness; no test timeout or app error was observed after it became ready.
- Actual packaged renderer→preload→IPC calls to API-context baseline, message page, search corpus, and global search returned/matched `canonical body survives restart`, matching arm64 results.
- After app exit, the copied profile remained `integrity_check=ok`, FK check empty, legacy body empty, `canonical-backed-only`, `write_mode=canonical`, `cleanup_state=complete`. The original fixture and other profiles were untouched.

## v0.2.4 allocator pending-cursor package fault smoke (2026-10-04)

- Copied the healthy schema-v46 canonical-only fixture to `/Users/space/Library/Application Support/SpaceAssistant-v024-allocator-pending`. Inserted one row into `agent_history_commit_cursor` through its production trigger, which registered the cursor in `agent_history_pending_commit_cursor` without a corresponding event. Before app launch, the integrity marker remained `invalid=0`; this represents a pending/unpaired allocation rather than direct table corruption.
- On the v0.2.4 arm64 package, the actual API-context, message-page, search-corpus and global-search IPCs each failed with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`. They did not return the warm L1 body or a successful empty result.
- After app exit the pending cursor remained visible, integrity check was `ok`, FK check empty, and the canonical-only message body remained empty. This package-level case validates unpaired allocator handling. Direct allocator UPDATE/DELETE integrity-marker corruption and broader owner/watermark variants remain outstanding.
