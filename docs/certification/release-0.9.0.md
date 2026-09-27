# 0.9.0 release fixes

Recorded 2026-09-27 on branch `release/0.9.0`, which starts from the M56
pull request (#44) head `d8dd7b4`. Two defects were found while preparing
the release. Both are fixed here, with tests and red drills.

## Model API keys in Meta's current format

**What was wrong.** The owner pasted a Model API key freshly issued by
dev.meta.ai. The extension's shape check, `MODEL_API_KEY_PATTERN` in
`src/shared/constants.ts`, allowed only `LLM|<numeric id>|<secret>`. The
new key starts with `LLM_` and has no `|`, so the key box in the panel would
have refused it as malformed.

The log redactor in `src/core/redact.ts` knew only the older shape too. A
current-format key that reached a log line would not have been masked.

**How the key was checked.** No key text was printed or stored in plain
text. The key went from the clipboard into a user-scoped DPAPI file in the
session scratchpad, and the clipboard was then cleared. A script printed
only the key's shape:

```
length=48 afterPrefix=punct'_' upper=14 lower=15 digit=17 punct=2 punctChars=[_]
```

A free `GET https://api.meta.ai/v1/models` with the key returned 200 and
eight models. The key is valid, so the shape check was wrong.

**The fix.**

- `MODEL_API_KEY_PATTERN` accepts `LLM_` followed by at least 16 of
  `[A-Za-z0-9_-]`, or the older shape: `/^(?:LLM_[\w-]{16,}|LLM\|\d+\|\S+)$/`.
- The redactor masks the same two shapes: `LLM_[\w-]{16,}` joins the older
  pattern. A short name such as `LLM_MODEL` is left alone.
- The key box's placeholder is now `LLM_…`. Its error reads "A Model API key
  starts with LLM\_ (older keys look like LLM|<numeric id>|<secret>)." The
  message is updated in all fourteen languages.

**Tests.**

- `test/unit/credentialStore.test.ts` accepts two synthetic current-shape
  keys, both older-shape keys, and a key with surrounding white space. It
  rejects `LLM_`, a key under 16 characters, keys containing a space or `$`,
  `LLM-…` and lower-case `llm_…`, and it stores a current-shape key.
- `test/unit/redact.test.ts` masks a current-shape key in text and in JSON.
  For every synthetic key it checks two things: the key store accepts the
  key, and the redactor masks all of it. So any shape the store takes is
  also redacted from logs. The test also leaves `LLM_MODEL` and
  `LLM_TIMEOUT_MS` alone.
- The synthetic keys are shared from `test/unit/helpers/modelApiKeys.ts`.
  They are low-entropy on purpose (`LLM_TestOnly000…`), so Gitleaks has no
  reason to flag them.

## Hooks run only in a trusted workspace

**What was wrong.** The documentation audit for 0.9.0 read
`loadHookDefinitions` in `src/core/backends/modelapi/hooks.ts`. With
`museSpark.modelApiHooks` on, it loaded the user's and the administrator's
hook commands whatever the trust state. Only the project's
`.muse/hooks.json` waited for trust. Restricted Mode promises that no shell
command runs, and the manifest says so. Your own hooks are not the
workspace's code, but they commonly run the workspace's tools, such as a
formatter or `npm test`. In an untrusted folder that means running the
folder's code.

**The fix.**

- An untrusted workspace loads no hook source. `loadHookDefinitions` returns
  before it reads any file.
- On the Model API backend, **Muse Spark: Hooks** marks a configured user or
  managed source with "Runs only once you trust this workspace", as it
  already did for the project's file. The Muse Code backend's view is
  unchanged, because Muse Code applies its own rules.

**Tests.**

- `test/unit/modelApiHooks.test.ts`: an untrusted workspace loads no hooks,
  and no hook file is read.
- `test/unit/museConfigCommands.test.ts`: while untrusted, the Model API view
  marks the project, user and managed sources. The Muse Code view marks only
  the project.

## Drills

Each drill broke one guard in memory, ran the suite that guards it, and
then restored the exact original bytes, checked by SHA-256. Git was not used
to restore them (`drills-090.mjs` in the session scratchpad).

| Drill | What was broken                                                 | Result           |
| ----- | --------------------------------------------------------------- | ---------------- |
| K1    | Key validation accepts only the older `LLM\|id\|secret` shape   | exit 1, 4 failed |
| K2    | Key validation drops its 16-character minimum                   | exit 1, 1 failed |
| K3    | The log redactor knows only the older shape                     | exit 1, 3 failed |
| K4    | The log redactor stops at `_` or `-` inside a current-shape key | exit 1, 2 failed |
| K5    | The log redactor matches any `LLM_` name                        | exit 1, 1 failed |
| H1    | User and managed hooks load in an untrusted workspace again     | exit 1, 1 failed |
| H2    | The Hooks view never says user or managed hooks wait for trust  | exit 1, 1 failed |
| H3    | The trust note is shown on the Muse Code backend too            | exit 1, 1 failed |

After the drills, the six focused suites passed 115/115. The changed files
passed ESLint and Prettier, and all five TypeScript projects passed.

## The search worker parses its job

The documentation audit found one unchecked boundary cast in `src`:
`workerData as SearchJob` in `src/host/backend/searchWorker.ts`. Only the
extension's own `toolIo.searchOnWorker` sends that job, but AGENTS.md rule 7
says every message across a thread boundary is parsed. The worker now parses
the job with a `zod/mini` schema before it searches. A malformed job ends
the search with its reason, as an invalid pattern already did.
`dist/searchWorker.js` grew from 3.6 KiB to 15.1 KiB, within its 50 KiB
budget.

`test/unit/searchWorker.test.ts` starts the bundled worker directly with
`maxHits: 'many'` and expects a `done` message whose reason names `maxHits`.
The suite passed 6/6.

| Drill | What was broken                                     | Result           |
| ----- | --------------------------------------------------- | ---------------- |
| S1    | The search worker trusts its job without parsing it | exit 1, 1 failed |

The `nosemgrep` reason in `src/host/backend/mcpJobLaunch.ts` now names the
packaged C# files the MCP launcher is compiled from (M56), not "fixed M50
source".

The audit also asked for a reason beside the two `as never` casts in
`test/unit/patchApply.test.ts`. They are gone instead: the test names its
two hunks and passes them in the wrong order directly, so
`noUncheckedIndexedAccess` has nothing to widen. Their §8 row is removed.

## The hosted-Windows hook stdin timeout

`test/unit/toolIo.test.ts` › "delivers hook JSON on stdin without placing it
in the command line (M51)" timed out on a hosted Windows runner twice, each
time on the first attempt of a pull request's run:

- PR #43 (run 36348351793, attempt 1): no stdout, no stderr, exit 1 after
  the 60 s hook timeout killed the tree;
- PR #44 (run 36350220096, attempt 1): the full echo and exit 0, but only
  after the 60 s timer had fired, so the result was marked timed out.

A rerun of each passed. Locally the same launch (Windows PowerShell 5.1,
the job join, `cmd.exe /D /S /C`, then Node reading stdin) passed 80 of 80
runs, four at a time, with and without `-InputFormat None`.

A temporary branch `diag/hook-stdin-windows` ran a push-triggered workflow
on `windows-latest` (run 36351144214). The runner had 4 CPUs and Defender
real-time protection off, and PowerShell 5.1 started in 131–153 ms. The
test passed in 20 isolated runs (20–28 s each, most of it compiling the job
helper) and in 5 runs of the whole file with coverage (32 passed, 2 skipped
each). One full `npm run test:unit` passed 2,513 tests (5 skipped). The
timeout did not reproduce.

The exit codes point at a slow start rather than lost stdin. A killed tree
reports 1, so the second failure's exit 0 means the hook finished on its
own just after 60 s. That fits the wrapper taking about 60 s to start the
hook on a fresh runner. Hook stdin that never ends fits less well. The test
now makes the hook write `hook started at <epoch ms>` to stderr. It also
fails on `isTimedOut` with that time and the run's start. A future failure
will therefore show whether the hook started late or started on time and
never saw its stdin end. The test's behaviour is otherwise unchanged. The
diagnostic branch and its workflow were deleted; they never reached `main`.

## Muse Code 1.4.0

Meta's `muse-stable` channel
(`https://api.meta.ai/muse-code/channels/muse-stable`) serves
`1.4.0-R4302.1`. The launcher checks the channel hourly and updates itself
in the background, so users are likely on 1.4.0 already. This machine was
still on `1.3.0-R3401.1`. Its last check was 2026-09-27 14:18, and it had
failed silently.

**Why the update failed.** The launcher (`muse.cmd`, then
`.muse-launcher.ps1`) runs under Windows PowerShell 5.1, but it inherited
PowerShell 7's `PSModulePath` from the session that started it. 5.1 then
could not load its own `Microsoft.PowerShell.Utility`. A synchronous update
(`MUSE_SYNC_UPDATE=1 muse --version`) stopped at `Get-FileHash` with
`CommandNotFoundException` and left `.muse-version` at 1.3.0. With
`PSModulePath` set to 5.1's own three folders, the same command downloaded
and verified the release and reported `Muse Code 1.4.0 (1.4.0-R4302.1)`.
This is Meta's launcher, not the extension; it goes in the upstream
reports.

**The extension on 1.4.0.** `@muse-code/sdk` on npm is still 1.3.0.
`test/e2e/live.e2e.test.ts` ran one reply-only turn through
`MuseCodeBackendManager` and the real 1.4.0 CLI (`MUSE_LIVE_E2E=1`, empty
temporary workspace). It passed in 85 s. The trace log
(`cli-f292cbb9-….log`, `mode="serve"`, `build_commit="aebe0c188"`) counts
**26 model attempts**, all on `muse-spark-1.3-contributor`. The drill now
uses the contributor model, as the owner's rule for live tests asks; it had
used the standard default.

## Documentation

A read-only audit of every shipped and project document against the code
(`docs-audit-0.9.0.md` in the session scratchpad: 22 must-fix, 41
should-fix and 35 nice-to-have items) was applied in full. The main
changes:

- the version is 0.9.0, and `CHANGELOG.md` has a `[0.9.0]` section, which
  `scripts/changelog-notes.mjs 0.9.0` turns into the release notes (it
  exited 1 before). The longest entries were cut to what a user sees; their
  details stay in the certification records;
- README: What's new, the settings table (the missing `modelApiHooks` row),
  the machine-scoped list, the privacy claims (MCP servers and hooks also
  receive conversation data), five paid features instead of three, the
  palette and slash lists, limits and troubleshooting;
- PRIVACY: hooks, the installer, device sign-in, subagents, scheduled
  prompts, what is stored on disk, and the proxy handed to Muse Code;
- SECURITY, AGENTS, CONTRIBUTING, the walkthrough text and the manifest's
  description and walkthrough step, in all fifteen manifest tables;
- PLAN statuses for M33–M56, the D36 table, Q6, §7 and §8, a stub for
  M44b (web fetch on the Model API backend), and the 0.9.0 record in §10;
- the certification index, and a dated closing section on each record that
  still said "pending" (M46, M48, M50–M55).

**Screenshots.** The walkthrough's four images were real captures from
2026-09-22. They showed other products' panel tabs and a file name from the
owner's workspace, and their UI was out of date. They are now harness
renders (`empty`, `tools`, `slash-palette`, `signin`). Ten README images
were re-rendered too. Each render was viewed before it was copied, and all
show fixture content only.

**A new harness scenario, `signin-install`,** shows the sign-in gate
without the CLI: **Install Muse Code**, **Open install instructions**,
**Check again** and **Use a Model API key**. It needs one line in
`scripts/lib/harnessServer.mjs`'s scenario list. The accessibility gate now
checks 332 pages (83 scenarios × 4 themes). With the scenario made to throw,
the gate exited 1 with 4 pages without a result; restored, it exited 0.

`npm run check:l10n`: 14 tables, 93 manifest strings, 226 source files, 0
problems.
