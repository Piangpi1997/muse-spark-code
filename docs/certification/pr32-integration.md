# PR #32 joined with main after M57 and M58

Recorded 2026-09-27 on branch `integrate/pr32` (PR #32's head, its earlier
merge of main `faace73` and the Open VSX namespace step, `2559a9b`), merging
main `72fa907`: the 0.9.0 release fixes, 0.9.1, M57 (the Model API backend
as its own bundle) and M58 (a popup before every paid use). PLAN.md D6 and
D62 amendments, M63.

## The merge

Seven files conflicted, all prose or lists: `AGENTS.md`, `CHANGELOG.md`,
`PLAN.md`, `README.md`, `docs/certification/README.md`, `package.json`
(the `cycles` entries). Both sides were kept:

- **`package.json`**: `npm run cycles` follows four entries, the extension,
  the Model API bundle (M57), the webview and the ACP agent.
- **`CHANGELOG.md`**: main released 0.9.0 and 0.9.1 after PR #32 branched,
  so git placed PR #32's four "Added" entries (the host API gate, the ACP
  agent, Open VSX and npm publishing, the host checks) and its "VS Code
  1.99 or newer" entry inside `[0.9.0]`. They are moved to `[Unreleased]`,
  where they belong: none of them shipped in 0.9.0.
- **`PLAN.md`**: D48 before D60–D62; the open questions with main's Q6 and
  PR #32's Q60–Q65; M57 before M60–M66; the gates table with main's bundle
  split and PR #32's host API and hosts rows, the cycles row with four
  entries and the aggregates with `check:host-api`.
- **`README.md`**, **`AGENTS.md`**, the certification index: main's rows
  and wording, with PR #32's `check:host-api`, `package:acp`, `test/hosts/`
  and ACP entries added.

What merged without a textual conflict but no longer fitted:

| Where                                 | What broke                                                                                                                                              | Fix                                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build.mjs`                   | M57's `modelApiOptions` used `NODE_TARGET`, which PR #32 had split into `HOST_NODE_TARGET` (node20.18, the 1.99 floor) and `AGENT_NODE_TARGET`          | `dist/modelApi.js` targets `HOST_NODE_TARGET`, as the activation bundle it is loaded beside                                                                                                          |
| `src/runtime/backends.ts`             | `confirmSubagentTask` (gone with M58); no `bundlePath` (required since M57)                                                                             | `allowsPaidUse` and `isPaidUseRemembered` through the agent's paid-use questions; `bundlePath` is `dist/modelApi.js` beside `acp.js` (below)                                                         |
| `src/acp/translate.ts`                | the approval subject's `paidFeature` (removed by M58, a paid call no longer gets an approval)                                                           | the approval title no longer names a price; a paid row still does                                                                                                                                    |
| `src/acp/agent.ts`                    | `error instanceof PromptSettledError`, which M57's lint rule refuses (the class may be the Model API bundle's copy)                                     | `isPromptSettledError`                                                                                                                                                                               |
| `test/unit/helpers/fakeModelApi.ts`   | M57's integration test loads it in VS Code; it used `Promise.withResolvers`, which the integration project (ES2023, PR #32's floor) and Node 20.18 lack | a plain promise, as M62 did in the host                                                                                                                                                              |
| `test/unit/helpers/modelApiBundle.ts` | built the bundle for `node22`                                                                                                                           | `node20.18`, the build's target since PR #32                                                                                                                                                         |
| `docs/ide-compatibility/host-api.md`  | stale: M58's popup (`MessageItem.title`, `isCloseAffordance`) and M57's `node:module`                                                                   | regenerated: 200 VS Code APIs, 13 files importing `vscode`, 17 Node built-ins; `modelApiEntry.ts` added to the portable list                                                                         |
| `l10n/`                               | the three strings of the agent's first-prompt price question                                                                                            | removed from `en.ts` and the 14 tables with the question (below); no new string: the agent's questions reuse the popup's own words (`paidUseQuestion`), already in all 15 languages. `check:l10n`: 0 |

## The agent and M57: `dist/modelApi.js` (PLAN.md D6 amendment)

The runtime's `ModelApiBackendManager` gets `bundlePath:
<dist>/modelApi.js`, the file the `.vsix` ships, and the agent's package now
ships it too (`scripts/package-acp.mjs`), with its packages in the agent's
third-party notices. The alternative, the entry bundled into `acp.js` and
handed over with `loadBundle`, was a second build of the same backend in a
second file. `check-bundle-split.mjs` now reads `dist/meta-acp/acp.json`
and fails when `acp.js` carries a lazy file or the entry;
`check-host-api.mjs` lists `modelApiEntry.ts` as portable. `acp.js` went
from 874.1 KiB (the joined tree before M57) to 713.2 KiB.

## The agent and M58: each paid use asks in the editor (PLAN.md D62 amendment)

- **One consent, the panel's.** `AcpPaidUse` (`src/acp/paid.ts`) builds the
  core's `PaidUseConsent` for the folder and session of each use. A feature
  is on only with its flag; subagents, scheduled prompts and Muse Voice have
  none, so they are denied without a question.
- **The question.** `session/request_permission` in the conversation the use
  is for: a `tool_call` row `paid-use-<n>` titled and described by
  `paidUseQuestion` (the popup's words, moved from `paidHost.ts` into
  `paidConsent.ts` so both say the same), options `allow_once`,
  `allow_always` (only with `--trust-workspace`) and `reject_once`. A
  cancel, an option not offered or a failed request is Deny; the row ends
  `completed` or `failed`.
- **Which conversation.** `ModelApiHostDeps.allowsPaidUse` gained a third
  argument, `sessionId`: the Model API host serves every conversation of a
  folder, and the agent must ask in the right ACP session. A child task's
  use carries its parent's id (`askingSessionId`). The extension ignores
  it. The agent denies when it holds no such session or no client attached.
- **"Always".** `src/runtime/paidGrants.ts`: `acp/paid-uses.json` in the
  agent's data folder, the folder's hash (`workspaceKey`, shared with the
  sessions folder) to feature names, validated with zod, read at every
  question, replaced atomically and one change at a time. At start
  (`serve`), a feature without its flag loses its grants in every folder.
- **Removed.** The first prompt's "Turn on" question (`AcpPaidFeatures.settle`,
  `confirmPaid`, the `preparing` state and the three `acpPaid*` strings):
  with the price named at every use, it would have asked twice before one
  prompt.

## Tests

| File                             | What it proves                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/acpAgent.test.ts`     | no flag or subagents: denied, nothing asked; each use asks in its session with the price and the untrusted options; "always" in a trusted folder stops the asking and is kept; Deny, a cancel, an option not offered and an unknown option deny; a failed request and an unknown session deny; a paid row names its price |
| `test/unit/acpPaid.test.ts`      | no asker, or one that throws: deny; "always" per folder, asked again where a hook demands it and not without trust; flags forget grants, a write failure is logged; the options and answers; the grants file: per folder, across processes, serialised writes, forget, damaged content                                    |
| `test/unit/acpModelApi.test.ts`  | through the runtime and a built `dist/modelApi.js`: each prompt that may search asks and the search is tallied; Deny sends the prompt without `web_search`; "always" kept in the data folder, honoured by the next agent, dropped by one started without the flag, asked again after                                      |
| `test/unit/acpRuntime.test.ts`   | a missing `dist/modelApi.js` fails in the user's words with the path logged; the grants file's place per platform                                                                                                                                                                                                         |
| `test/unit/modelApiHost.test.ts` | the host names the conversation of each paid use: two conversations' web search, the spawn, the owner's follow-up and a child's image, the child's asked in its parent's                                                                                                                                                  |
| `test/e2e/acpStdio.e2e.test.ts`  | a Model API turn through the package's own `dist/modelApi.js` (the laid-out package, and with `MUSE_ACP_PACKAGE_DIR` the installed one)                                                                                                                                                                                   |

Also run on this tree: the packed agent (`node scripts/package-acp.mjs`,
23 files, `dist/modelApi.js` among them) installed into a scratch prefix,
the stdio suite against it: 5 of 5. `npm run test:integration`: 10 passing
on VS Code 1.139.1 and 10 on 1.99.0, M57's bundle test among them.

## Drills

Each broke one thing, the named check failed, and the file was restored
(content hash compared).

| Drill | Break                                                                                             | Result                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| P1    | `AcpPaidUse.isOn` true for every feature                                                          | exit 1: "denies without asking a feature it has no flag for, and subagents always"                                   |
| P2    | the agent answers "once" for a session it does not hold                                           | exit 1: "denies when the client cannot answer, or the session is not one the agent holds"                            |
| P3    | "Allow always" offered without `--trust-workspace`                                                | exit 1: "asks before each use in its session, naming the price; Allow once allows that use only"                     |
| P4    | "Allow always" taken although it was not offered                                                  | exit 1: "denies on an option it was not offered, and keeps nothing"                                                  |
| P5    | `forgetUnflagged` forgets nothing                                                                 | exit 1: "keeps "Allow always" for a trusted folder until the agent starts without the flag (M58)"                    |
| P6    | `askingSessionId` is the child's own id                                                           | exit 1: "asks each paid use in its conversation, a child's in its parent's (M58, PLAN.md D62)"                       |
| P7    | no asker attached answers "once"                                                                  | exit 1: "denies every use until the agent attaches its way to ask"                                                   |
| P8    | the grants file keeps names that are not paid features                                            | exit 1: "counts a damaged file, or names that are not paid features, as no grants"                                   |
| P9    | a hook's demand to ask dropped (`requiresAsking` false)                                           | exit 1: "keeps "always" per folder, asks again where a hook demands it, and not without trust"                       |
| B1    | the runtime hands the manager the entry module (`loadBundle`), bundling the backend into `acp.js` | `check-bundle-split.mjs` exit 1: 21 problems, "dist/acp.js carries src/core/backends/modelapi/ModelApiHost.ts, …"    |
| B2    | `modelApiEntry.ts` imports a `vscode` type                                                        | `check-host-api.mjs` exit 1: "src/host/backend/modelApiEntry.ts reaches `vscode`", "Uri is a VS Code type"           |
| B3    | `scripts/package-acp.mjs` without `modelApi.js`, packed and installed                             | the installed-package suite: 1 failed, 4 passed, "ships the Model API backend beside the agent" (`MODULE_NOT_FOUND`) |

## The agent's budget (PLAN.md D6 amendment)

After the merge, from the production build's metafile:

| Bundle                 | Size      | Budget                |
| ---------------------- | --------- | --------------------- |
| `dist/extension.js`    | 432.5 KiB | 600 KiB, unchanged    |
| `dist/modelApi.js`     | 299.5 KiB | 400 KiB, unchanged    |
| `dist/searchWorker.js` | 15.2 KiB  | 50 KiB, unchanged     |
| `dist/webview/main.js` | 751.7 KiB | 900 KiB, unchanged    |
| `dist/acp.js`          | 713.2 KiB | **850 KiB** (was 800) |

`acp.js`: zod 445.2 KiB (257.6 of it the 64 locale files of the classic API
the ACP SDK imports, 185.0 its core and classic API, 2.5 the panel's
`zod/mini`), the English table 58.6, the ACP SDK 53.7, the Muse Code SDK
14.7, and the engine, `src/acp` and `src/runtime` about 155. 713.2 × 1.15 =
820.2, rounded up to 850. Gzipped, `acp.js` is 175.1 KiB; the packed agent
(`muse-spark-code-acp-0.9.1.tgz`) is 611,034 bytes.

Drill: the agent's budget set to 700 KiB, `check-bundle-size.mjs` exit 1,
"OVER dist/acp.js: 713.2 KiB (budget 700 KiB)"; restored, "ok … (budget 850
KiB)".

## Networks and proxies (`docs/acp.md`, PLAN.md Q66)

What reaches the agent's two network paths, read from the code and then
measured on this machine (Windows 11) with a throwaway script:

- **The code.** The agent hands the Model API backend
  `globalThis.fetch` (`src/runtime/main.ts`), Node's own `fetch`, with no
  dispatcher of its own. Muse Code's manager gets no editor proxy
  (`NO_EDITOR_PROXY` in `src/runtime/backends.ts`) and no extra variables,
  so `muse serve` inherits the agent's environment, with loopback added to
  `NO_PROXY` whenever a proxy is set (`withLoopbackBypass`, M56).
- **The agent's `fetch`, measured.** A local proxy on 127.0.0.1 logged each
  request line and answered `CONNECT` with 502, so nothing left the
  machine; the target, `https://muse-probe.invalid/`, cannot resolve, so a
  direct attempt fails with `ENOTFOUND`. Each case ran in a fresh Node
  process with only its own variables:

  | Environment                                      | 22.0.0  | 22.20.0 | 22.21.0 | 22.23.3            | 24.0.0  | 24.5.0 | 24.20.0            |
  | ------------------------------------------------ | ------- | ------- | ------- | ------------------ | ------- | ------ | ------------------ |
  | `HTTPS_PROXY` only                               | direct  |         |         | direct             |         |        | direct             |
  | `https_proxy` only                               | direct  |         |         | direct             |         |        | direct             |
  | `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`           | direct  | direct  | proxy   | proxy              | proxy   | proxy  | proxy              |
  | `https_proxy` + `NODE_USE_ENV_PROXY=1`           | direct  |         |         | proxy              |         |        | proxy              |
  | `HTTP_PROXY` + `NODE_USE_ENV_PROXY=1`            | direct  |         |         | proxy              |         |        | proxy              |
  | `HTTPS_PROXY` + `NO_PROXY=.invalid` + the switch | direct  |         |         | direct             |         |        | direct             |
  | `ALL_PROXY` + the switch                         | direct  |         |         | direct             |         |        | direct             |
  | `HTTPS_PROXY=http://user:pass@…` + the switch    | direct  |         |         | proxy, credentials |         |        | proxy, credentials |
  | `HTTPS_PROXY` + `NODE_OPTIONS=--use-env-proxy`   | refused | refused | proxy   | proxy              | refused | proxy  | proxy              |

  "proxy": the proxy logged `CONNECT muse-probe.invalid:443` and `fetch`
  failed with "Proxy response (502) !== 200 when HTTP Tunneling";
  "credentials": a `Proxy-Authorization` header came with it; "direct":
  the proxy saw nothing and `fetch` failed with `ENOTFOUND`; "refused":
  Node would not start ("--use-env-proxy is not allowed in NODE_OPTIONS");
  an empty cell was not run.

- **Certificates, measured.** A local HTTPS server with a throwaway
  self-signed certificate: without a variable every Node refuses it
  (`DEPTH_ZERO_SELF_SIGNED_CERT`); with `NODE_EXTRA_CA_CERTS` naming it,
  `fetch` answers 200 on 22.0.0, 22.14.0, 22.15.0, 22.23.3 and 24.20.0.
  `NODE_OPTIONS=--use-system-ca` is refused by 22.0.0 and 22.14.0 and
  accepted from 22.15.0; whether it then trusts a root in the operating
  system's store was not exercised (that needs a root installed there).
- **Muse Code** reads `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and
  `NO_PROXY`, trusts the operating system's store, and takes
  `SSL_CERT_FILE` or `SSL_CERT_DIR` in its place, as recorded for the
  extension in M56 (`docs/certification/m56.md`); the agent changes
  nothing of that, and hands it no VS Code setting.

The agent does not turn Node's switch on by itself, and the network-failure
advice (M56) names VS Code's settings: both are open for the owner as
PLAN.md Q66, and `docs/acp.md` gives the variables that work today.

## The key store on the owner's rigs

`test/hosts/keystore.sh` with its made-up key, on the agent packed from this
branch: Windows 11 VM (Credential Manager, in the owner's console session)
and Mac mini (a keychain of the run's own): both `ok`, nothing left behind.
Over SSH with a key, Windows refuses Credential Manager
(`ERROR_NO_SUCH_LOGON_SESSION`) and the agent stores nothing; now in
`docs/acp.md`. Details in `m63.md`, "The key store on the owner's rigs".
