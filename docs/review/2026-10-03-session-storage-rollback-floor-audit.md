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
| Compatible rollback build | **Not built or published** |
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

## Cache-version follow-up (2026-10-04, v259 working tree)

This is code-level preflight evidence after the integrated candidate's assistant stable-ID projection was corrected. It does not establish an R release or alter the No-go gate.

- A TDD regression reproduced that a persisted v1 L1 cache could return duplicate assistant content after the canonical fold was changed to keep only the final response for a stable assistant ID.
- The cache format version is now 2, including empty session projection seeds. A cache-version drift regression confirms canonical-only reads rebuild from History instead of trusting the stale v1 L1 entry.
- Focused suite: 6 files / 406 tests passed. Full suite: 866 files passed / 1 skipped; 8,233 tests passed / 106 skipped. Renderer/shared/agent-sdk/Electron typechecks, `npm run build`, strict i18n, and `git diff --check` passed.
- The worktree build needed a local ignored `node_modules/@earendil-works/pi-ai` link to the already installed lockfile version 0.87.1; no dependency manifest or lockfile changed.
- Schema remains v49. No signed installer or R→C→R installation drill exists. Current disk has about 400 MiB free and the machine has zero valid Developer ID identities. Gate remains No-go; production stop-write/cleanup stays locked.
