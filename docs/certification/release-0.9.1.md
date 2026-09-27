# 0.9.1: Muse Code 1.4.0 on Windows

Recorded 2026-09-27 on branch `hotfix/0.9.1`, from main `2f4f669` (0.9.0).

## What was found

Meta's `muse-stable` channel serves `1.4.0-R4302.1`, and Muse Code's
launcher installs it without asking (release-0.9.0.md, "Muse Code 1.4.0").
After 0.9.0 shipped, a re-test of the Windows bugs the panel works around
ran on that build. It used four billed turns on
`muse-spark-1.3-contributor`, 28 model attempts in all, each counted from
its session's trace log. The rest of the probes needed no model call.

| Upstream issue                            | 1.3.0                    | 1.4.0-R4302.1                                           |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------- |
| #30 `session/rename` on Windows           | `UnsupportedPlatform`    | the same error, with and without a turn                 |
| #31 `session/fork` on Windows             | `WriteFailed`            | the same error, with and without a turn                 |
| #26 sandbox shell folder under `C:\Users` | wrong folder after ~34 s | still the wrong folder; the wait is gone (1.2 s)        |
| #29 `approval/decide` ledger fence        | intermittent             | two clean decisions; the message is still in the binary |

0.9.0 applied its two Windows limits only up to `1.3.0`:

- `WINDOWS_SESSION_EDITS_LIMITED_MAX_VERSION` decided
  `AgentHostInfo.canEditSessions` (`MuseCodeHost.ts`);
- `SANDBOX_PROFILE_LIMITED_MAX_VERSION` decided the profile-workspace
  warning (`sandbox.ts` `isProfileWorkspaceLimited`).

The unit tests even asserted that `1.4.0` was unaffected. On 1.4.0 the
panel therefore offered Rename, **Rewind conversation to here** and
**Side chat** on Windows again, and each of them failed. It also dropped
the warning that shell commands start in PowerShell's folder, which is
still true.

Every 1.4.0 start also logged `MSP schema fingerprint mismatch` as a
warning. `@muse-code/sdk` 1.3.0, still the latest on npm, pins
`sha256:7469c9e3…`. 1.4.0 serves `sha256:99a7458c…` (R4302.1) and
`sha256:36466f63…` (R4161.1). These are Meta's release manifests' own values,
and a schema diff shows only additions: `session/delete`, the declared
`session/started`, `session/closed` and `session/deleteCompleted`,
`ModelCatalogEntry.variants` and `AccountState.avatarUrl`.

The full findings are `muse-1.4.0-delta.md` in the session scratchpad.

## The fix

- **The Windows limits hold for every version.** `canEditSessions` is false
  whenever the host reports Windows. The profile-workspace warning uses
  `isProfileWorkspace` alone. The two version constants,
  `isVersionAtMost` and `isProfileWorkspaceLimited` are removed, since
  nothing uses them any more. A limit is lifted only by a release, once a
  Muse Code version has been verified to fix it (PLAN.md D26 amendment).
- **Wording.** `sessionEditsUnsupported` no longer names 1.3.0.
  `sandboxProfileNotice` says "Muse Code's Windows sandbox" instead of
  "this Muse Code version", and it drops "take about half a minute each".
  Both changes are in all fourteen tables, as substring edits that keep
  each table's punctuation. `check:l10n` found 0 problems. The README's
  troubleshooting entries name 1.3.0 and 1.4.0.
- **Known fingerprints.** `MSP_KNOWN_SCHEMA_FINGERPRINTS` maps the two 1.4.0
  fingerprints to their builds. `MuseCodeBackendManager.logFingerprint`
  logs one of those at info ("an additive successor of the SDK's …"). Any
  other mismatch is still a warning.

## Tests

- `MuseCodeHost.test.ts`: Windows is limited on `1.3.0-R3401.1`,
  `1.4.0-R4302.1`, `1.5.0` and `dev`; Linux and macOS are not.
- `sandbox.test.ts`: `isProfileWorkspace` covers the profile in any letter
  case, a sibling prefix, and off Windows.
- `museCode.e2e.test.ts` runs the real backend manager against the fake
  `muse serve`:
  - a known 1.4.0 fingerprint gives the info line and no warning;
  - an unknown fingerprint warns;
  - the pinned fingerprint does neither.
- The controller's profile-workspace warning test is unchanged. It no
  longer depends on the version the fake reports.

## Drills

Each drill broke one guard in memory, ran its suite, and restored the exact
bytes, checked by SHA-256 (`drills-091.mjs` in the session scratchpad).

| Drill | What was broken                                                         | Result           |
| ----- | ----------------------------------------------------------------------- | ---------------- |
| W1    | Rename and fork offered on Windows from 1.4.0 again (the 0.9.0 ceiling) | exit 1, 1 failed |
| W2    | The profile-workspace warning never shown                               | exit 1, 1 failed |
| F1    | A known 1.4.0 fingerprint still logged as a mismatch warning            | exit 1, 1 failed |
| F2    | Every fingerprint mismatch treated as known                             | exit 1, 1 failed |

## Gate

`npm run quality` on `9c2cdce` (Windows 11, Node 22), exit 0:

- format, lint (ESLint, stylelint, PSScriptAnalyzer), five TypeScript
  projects, `check:l10n` (14 tables, 0 problems), knip, dpdm, jscpd (0 clones);
- vitest with coverage: 173 files passed and 2 skipped; 2,507 tests passed
  and 23 skipped; statements 94.21 %;
- build and budgets: `dist/extension.js` 596.7 KiB of 600;
- a11y: 332 pages (83 scenarios × 4 themes), 0 rules violated;
- gitleaks: no leaks; Semgrep: 287 rules on 404 files, 0 findings.

## Not in this release

- Offering `session/delete`, which is new in 1.4.0. It fails on Windows
  and on memory-only hosts, and it is untested on macOS and Linux.
- Effort levels read from `model/list` `variants`.
- Sign-in detection if 1.4.0 keeps new macOS credentials in the Keychain
  instead of `auth.json`. This is under investigation.

Each of these is tracked in PLAN.md.
