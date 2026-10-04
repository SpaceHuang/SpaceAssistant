# Phase 5.5 rollback floor audit

## Decision

**No-go for stopping legacy body writes or clearing `messages.content`.** The currently published `v0.2.2` tag is not a compatible rollback target. A compatible rollback release has not been built or published, and physical cleanup must remain locked until that release is verified.

This is a compatibility audit package, not approval to perform cleanup.

## Evidence

- Published tag `v0.2.2` declares database schema version 19 (`electron/database/schema.ts`). The current integration candidate declares schema version 49 and includes additive session-content state, eligibility, spill-GC, History invalidation, transcript-cache checksum, persisted write-stopped cleanup-state, completed-cleanup-ledger immutability, canonical-only body immutability, and global History allocator integrity migrations.
- `v0.2.2` has no `electron/runtime/sessionTranscriptProjection.ts` or `electron/runtime/sessionContentWriteAuthority.ts`. Its user-facing message reads in `electron/database/operations.ts` select `messages.content` directly, including `getMessages`, `getTurnContext`, sequence paging, and route-window reads.
- Current `electron/database/migrations.ts` rejects a database whose schema version is newer than the binary supports. A v0.2.2 rollback against the current schema-49 profile therefore fails before opening the application. If that version guard were bypassed, the old readers would still return empty bodies for rows already cleared by Phase 5.5.
- Current Phase 5.4 retains legacy bodies and dual writes. That keeps the present database content readable by a compatible older build only while those copies remain intact; it does not make v0.2.2 a rollback target after a future clear.

## Minimum compatible rollback release

Before any legacy body is cleared, publish and preserve a rollback build that:

1. Opens the exact schema version written by the cleanup release without downgrading or rewriting the database schema.
2. Understands `content_storage_state='canonical-backed-only'` and reads each such body through the canonical History projection with spill checksum validation and fail-closed behavior.
3. Covers every production body consumer needed after rollback, including transcript/chat, API context, turn routing and `reuse-user`, search, export/backup, retry, and recovery.
4. Does not repopulate cleared legacy bodies from stale mirrors, and preserves all control metadata, queue/turn state, attachment references, and preview invariants.
5. Has a kill switch or documented recovery path that returns to the preserved legacy copies before cleanup begins; after cleanup, rollback is limited to the compatible release floor.

## Required release-floor verification

Use a disposable copy of a real file-backed database at the exact cleanup-release schema (currently schema 49) with representative canonical-backed-only rows, multi-spill bodies, cache hit/miss states, queued messages, active/terminal turns, and backup/restore artifacts. Include a paired and an unpaired global History allocator cursor so the rollback floor verifies v49 cursor-integrity handling as well as transcript reads. Verify that the proposed floor build opens it, reads the canonical bodies after process restart, rejects missing/corrupt History or spill without returning empty content, and leaves the original profile untouched. Record the exact release identifier, schema version, test fixture, and result. The release must be published and retained before the first cleanup batch; a worktree, unmerged branch, or local build is not a release floor.

## Gate status

| Gate | Status |
| --- | --- |
| Current published rollback target compatibility | **Failed** (`v0.2.2`, schema 19; canonical-only reader absent) |
| Compatible rollback build | **Local candidate package built; formal tag release not published** |
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

## Cache-version follow-up (2026-10-04, commit `d3fd9727`)

This is code-level preflight evidence after the integrated candidate's assistant stable-ID projection was corrected. It does not establish an R release or alter the No-go gate.

- A TDD regression reproduced that a persisted v1 L1 cache could return duplicate assistant content after the canonical fold was changed to keep only the final response for a stable assistant ID.
- The cache format version is now 2, including empty session projection seeds. A cache-version drift regression confirms canonical-only reads rebuild from History instead of trusting the stale v1 L1 entry.
- Focused suite: 6 files / 406 tests passed. Full suite: 866 files passed / 1 skipped; 8,233 tests passed / 106 skipped. Renderer/shared/agent-sdk/Electron typechecks, `npm run build`, strict i18n, and `git diff --check` passed.
- The worktree build needed a local ignored `node_modules/@earendil-works/pi-ai` link to the already installed lockfile version 0.87.1; no dependency manifest or lockfile changed.
- Schema remains v49. No signed installer or R→C→R installation drill exists. Current disk has about 400 MiB free and the machine has zero valid Developer ID identities. Gate remains No-go; production stop-write/cleanup stays locked.


## Fixed-commit code checkout (2026-10-04, `d3fd972722420fc5aff0b6f83afc6b37cfdba72e`)

- Detached the existing clean-code checkout at the exact cache-version commit. The worktree was clean before and after validation.
- Full suite passed: 866 files passed / 1 skipped; 8,233 tests passed / 106 skipped. Shadow p95 was 11.12 ms and canonical API p95 was 10.75 ms.
- Renderer/shared/agent-sdk/Electron typechecks, full `npm run build`, strict i18n (0 source occurrences; 1,214 test occurrences), and `git diff --check` passed.
- This checkout's `node_modules` was not self-contained. Validation resolved dependencies from the existing local dependency store and added ignored links for TypeScript 5.9.3 and `@earendil-works/pi-ai@0.87.1`. `npm ci` has not been rerun at this exact commit; the result is fixed-commit code/build evidence, not fresh-install evidence.
- No distribution installer, installation/rollback drill, R publication, or C artifact exists. Disk space is approximately 375 MiB and the machine has zero valid Developer ID identities. Gate remains No-go; stop-write/cleanup remains locked.


## Post-review fixes (2026-10-04, v261 working tree)

OCR re-review of `a285443a` found two issues; the current working tree fixes them, but this is not yet a fixed candidate commit.

- High: continuation context can intentionally remove the stable ID from an intermediate assistant response. The raw History event remains intact for provider context, while `canonicalSessionTranscriptEvents` now omits only id-less assistant messages from UI transcript snapshots. A file-backed session History regression failed before the fix and passes after it; other malformed roles/IDs remain fail-closed.
- Low: legacy JSON `generation` is untrusted. A non-string previously caused `.trim is not a function` before migration error handling. Both preparation and insertion now share a type-safe UUID normalizer; migration regression reproduced and passes.
- Focused cross-area suite: 5 files / 337 tests passed. Full suite: 866 files passed / 1 skipped; 8,235 tests passed / 106 skipped. Renderer/shared/agent-sdk/Electron typechecks, full build, strict i18n, and `git diff --check` passed. Strict i18n reports 0 source occurrences and 1,214 test occurrences.
- OCR review of the fixes returned 0 findings. No schema migration or cleanup protocol changed. The fix still needs a fixed commit and clean checkout validation. The distribution R, published rollback drill, and cleanup authorization remain absent; local disk space is about 373 MiB and no Developer ID identity is available.


## Fresh-install R package preflight (2026-10-04, commit `67ec4549`)

This addendum supersedes earlier local-space/Developer-ID blocker statements. The repository's [`release.yml`](../../.github/workflows/release.yml) uses the normal afterPack ad-hoc signature and verifies the app bundle; [`release-appendix.md`](../../.github/release-appendix.md) explicitly documents that published packages are not Apple-signed. A Developer ID is therefore not required by the current repository release workflow.

- `origin/main` is `6b2ba5a7`, and is an ancestor of the candidate branch. The candidate code commit is `67ec4549fc39f2b16f526417e00b54fd8f4422ee`.
- A fresh detached checkout ran `npm ci` successfully. The prescribed focused migration/cutover/projection tests passed (354); the full suite passed (866 files / 1 skipped; 8,235 tests / 106 skipped). Renderer/shared/agent-sdk/Electron checks, normal and strict i18n, full build, and `git diff --check` passed. npm reported 32 dependency advisories (1 critical, 20 high, 10 moderate, 1 low); the production-only audit reports 3 high and no critical. No automatic dependency upgrades were applied.
- `npm run pack:mac` produced `release/SpaceAssistant-0.2.2.dmg` (x64, SHA-256 `d7e0f91e1495fbb20c2e28d52a52c6a52599ef8b2458b08c99af41cee38e0692`) and `release/SpaceAssistant-0.2.2-arm64.dmg` (SHA-256 `d1f2c5edd8781bdf5aed3eab1b395b9db931e4c4d6782f84ca4735998334ced0`). Both passed `hdiutil verify`; app resources and ad-hoc signature verification passed. These local package filenames use 0.2.2, an already-published version, so they are preflight artifacts only and must not be distributed as R.
- A disposable profile created with main's schema-v33 DB API and a legacy user message was started from the x64 DMG, closed, restarted, and launched again from a temporary copy of the packaged app. Schema advanced to 49; the same message ID/body/status/sequence remained; `PRAGMA integrity_check` returned `ok`. No stop-write/cleanup API was called. UI was not verified.
- The package metadata is being advanced to `0.2.3` for the next R candidate; this version bump and the matching fixed commit still require clean `npm ci` verification and CI packaging. No R tag/release or C exists. Production stop-write/cleanup remains locked.


## Versioned R candidate clean install (2026-10-04, commit `edae9ce6`)

- The proposed next release version is `0.2.3` (the latest existing tag is `v0.2.2`). Commit `edae9ce619140fd419569709ff1d0b2af7ab0922` updates `package.json` and lockfile metadata only and includes the current audit/plan state. `origin/main` (`6b2ba5a7`) is an ancestor of the candidate.
- A fresh detached checkout at this exact commit ran `npm ci` successfully. Focused required tests passed (354); full suite passed (866 files / 1 skipped; 8,235 tests / 106 skipped); renderer/shared/agent-sdk/Electron typechecks, normal/strict i18n, full build, and `git diff --check` passed. Full-suite shadow/canonical API p95 was 10.93/10.82 ms.
- npm reports 32 advisories (1 critical, 20 high, 10 moderate, 1 low); production-only audit reports 3 high, no critical. No automatic dependency changes were made.
- Local x64/arm64 DMGs from the previous code commit carry package version 0.2.2 and are only code/install-flow preflight, not candidate R artifacts. The official release workflow triggers on a `v*` tag on main and builds/tests/packages version 0.2.3. No tag/release has been created; the candidate branch is not yet pushed or merged.
- The actual R→C→R drill remains pending because C has no real-profile cleanup entry and R has not been published. Do not enable production cleanup.
