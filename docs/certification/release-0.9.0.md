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
