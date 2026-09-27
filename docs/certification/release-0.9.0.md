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

## Live Model API sweep

Recorded 2026-09-27 on branch `live/modelapi-sweep` (from `1d1b281`, this
release's fixes). `test/e2e/modelApi.live.e2e.test.ts` drives the production
Model API backend against Meta's real API: `ModelApiBackendManager` over the
real client and the live `fetch`, and the real file, shell (in a Windows job
object), memory, MCP, hook and schedule I/O, each case in an empty temporary
workspace with its own config, data and storage folders. Only the UI is
replaced, by an answerer that allows each card once, accepts each price and
explains instead of answering a question. Every model call used
`muse-spark-1.3-contributor`. The key came from a DPAPI file through a
wrapper script that sets it for one run and filters it from the output. The
test takes it out of the environment on load, and each case checks that no
log line, event or file under its folder holds it.

The full run, then the two cases rerun after it (case06 with its objective
reordered, case12 with image usage reported apart):

| Case                                     | Result | Requests | Est. $ | What it proved                                                                                                                                                   |
| ---------------------------------------- | ------ | -------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 plain reply                           | pass   | 4        | 0.0007 | `GET /models` lists the contributor model; `24h` retention accepted; thinking off sends `minimal`; the second same-effort request hit the cache (3185/3230)      |
| 02 tools                                 | pass   | 5        | 0.0005 | `read_file`, `edit_file` and `powershell` each through a Manual card; the file changed on disk                                                                   |
| 03 replay (M42)                          | pass   | 3        | 0.0004 | a second turn replaying reasoning, `function_call` and its output was accepted                                                                                   |
| 04 images                                | pass   | 3        | 0.0005 | an attached 64x64 PNG read as "red"; a PNG read by `read_file` went after the outputs as `message:user[input_image]` and read as "blue"                          |
| 05 PDFs (M54)                            | pass   | 3        | 0.0005 | an attached PDF read as MARIGOLD; one read by `read_file` went as `input_file` after the outputs, read as TANGERINE                                              |
| 06 goals (M45)                           | pass   | 3        | 0.0008 | the goal tools offered and accepted; `get_goal`, then `update_goal`: active to complete                                                                          |
| 07 memory (M49)                          | pass   | 2        | 0.0004 | `add_memory` wrote the note and its index line where `MemoryStore.locate` puts it, under the case's own data home                                                |
| 08 MCP (M50)                             | pass   | 4        | 0.0005 | the fixture stdio server from Muse Code settings; `echo` round trip; a tool result with a picture went back as `function_call_output[input_image]` and was taken |
| 09 hooks (M51)                           | pass   | 2        | 0.0008 | trusted: the `UserPromptSubmit` hook wrote its marker and its stdout reached the model; untrusted: no marker, no context                                         |
| 10 subagents (M48)                       | pass   | 4        | 0.0008 | spawn card allowed; the child ran on the contributor model and returned PONG to `subagent_wait`                                                                  |
| 11 web search (M33)                      | pass   | 2        | 0.0034 | one search, counted and marked paid; the next turn replayed commentary and `web_search_call` and was accepted                                                    |
| 12 image generation and edit (M34, M44)  | pass   | 6        | 0.0206 | both cards allowed, both PNGs written, two images counted                                                                                                        |
| 13 scheduled prompt (M52)                | pass   | 1        | 0.0003 | `/loop 1m` parsed and created; the confirmed run of the due occurrence ran once and was counted                                                                  |
| 14 Muse Voice (M35)                      | pass   | 1 (WS)   | 0.0002 | a SAPI-spoken WAV streamed at real time; transcript exact; 3 s counted; socket closed 1000                                                                       |
| 15 compaction                            | pass   | 5        | 0.0007 | a summary request replaying a tool call with no tools offered was accepted; the next turn recalled CINNAMON from the summary                                     |
| 16 resume, fork, side chat (D14, M53)    | pass   | 5        | 0.0005 | a stored session resumed in a new window, a rewind fork and a side chat, each continued                                                                          |
| 17 rules and a skill (D13)               | pass   | 3        | 0.0006 | `AGENTS.md` obeyed; a project skill listed and invoked                                                                                                           |
| 18 a question, then Stop at a card (D26) | pass   | 4        | 0.0006 | the question settled as clarified; Stop at the shell card cancelled the turn; the next turn replayed the stopped call with its output                            |

No request was refused: every HTTP status was 200. The image endpoints
return a usage object (about 9,400 to 11,600 input and 330 output tokens per
image). Meta's pricing page says it is "for reference" and that images are a
flat $0.01, which is what the extension counts.

### The defect it found

**What was wrong.** `askUser` in `ModelApiHost.ts` emitted
`questionRequested` before it held the question as pending. An answer given
in the same tick was refused with "question … is not pending", and the turn
waited forever (case18's first run, 240 s timeout). Approval cards were
already registered first. The panel answers later through the webview, so
this was latent in the product, but any listener answering in the event
would hang the turn.

**The fix.** The card is emitted inside `waitFor`'s register callback, after
the pending entry is set, as `askApproval` does.

**Test.** `test/unit/modelApiHost.test.ts`, "takes an answer given as the
card arrives": a listener clarifies inside the event. Without the fix it
fails in 83 ms ("question id6 is not pending"); with it the suite passes
290/290.

### What the harness got wrong first

- An 8x8 PNG reached Meta intact (`message:user[input_image]`, 200), but at
  a few tokens the model answered "grey", then "white", after looking for a
  file with `list_files`. At 64x64 it is seen.
- A hook's context arrives as plain user text (M51's design), so asking
  whether "a hook gave you a word" got NONE. The prompt now asks for the word.
- Once, the model replied DONE before calling `update_goal`. The objective now
  puts the tool call first.
- vitest 5's default reporter hides a passing test's `console.warn`, so the
  summary goes to stderr directly. `live.e2e.test.ts` (the CLI drill) prints
  its attempt count with `console.warn` and is affected the same way.

### Drills

| Drill | What was broken                                                                 | Result                                                     |
| ----- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Q1    | The question emitted before it is pending (the code before the fix)             | the unit test failed, 1 failed; the live case18 hung       |
| L1    | The key-leak scan pointed at a planted marker in a log line and a file (case14) | failed with `[ 'the log', 'drill.txt' ]`; reverted by copy |

### Spend

34 live runs, 150 requests (147 HTTP, 3 WebSocket), about $0.095 estimated
in total: $0.06 for six images (case12 ran three times), $0.0075 for three
searches, the rest tokens. Failed runs are included: case04 twice (8x8),
case09 once (prompt), case18 once (the defect), the full run (case06), and
drill L1.
