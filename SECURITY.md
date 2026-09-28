# Security policy

Muse Spark Code (Unofficial) runs a coding agent inside VS Code: it reads
and edits files in your workspace, runs shell commands with your approval,
and sends your prompts to Meta. Security problems in that surface are taken
seriously and fixed first.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

- Use GitHub's private vulnerability reporting on this repository:
  **Security → Report a vulnerability** at
  https://github.com/RandyNorthrup/muse-spark-code/security/advisories/new.
- Include the extension version (`Muse Spark: Diagnostics` in the Command
  Palette writes the versions and the configuration facts to the log; it
  contains no credentials), the steps to reproduce, and what an attacker
  gains.

You will get an acknowledgement within seven days. A confirmed
vulnerability is fixed in a patch release and credited in the changelog
unless you prefer otherwise.

## Supported versions

Only the latest release on the Visual Studio Marketplace receives fixes.

## What the extension protects, and how

- **Credentials.** A pasted Model API key lives only in VS Code's
  SecretStorage, is sent only to `api.meta.ai`, and is never passed to a
  child process, written to settings or logs, or shown in the panel. The
  extension reads only the structure of the Muse Code CLI's own credential
  file, never a token in it: the schema version, which providers it names
  (only `meta` speaks for the sign-in), each one's storage lane (the macOS
  Keychain), and whether `meta` has an `api_key` or `access_token` entry
  (the parse keeps the fact, never the value). When that is not enough, it
  asks the CLI (`account/read`) and discards the account label and avatar
  address the answer carries. It never reads the Keychain's secret.
  In-panel sign-in, that question and sign-out (`account/logout`) run in a
  temporary `muse serve` that owns no conversation and is closed on
  success, cancel, timeout, error or when the window closes, after which
  no sign-in starts; a sign-in whose host exits fails at once unless the
  credential file changed first, by a write no `account/read` answer
  called signed out. The only page sign-in opens must be on
  `https://auth.meta.com`. The log channel redacts key-shaped strings, in
  Meta's current `LLM_…` form and the older `LLM|<id>|<secret>` one; it
  cannot catch a path or an e-mail address, so free text Muse Code writes
  (sign-in endings, MSP error messages, `muse serve` and `muse skills`
  stderr) is logged in fixed words, by its kind, or by its length, never
  as sent.
- **Workspace trust.** In VS Code's Restricted Mode the agent loads no
  workspace rules, skills or memory, runs no shell commands, and the
  extension runs no `git` (a repository's `.git/config` can name programs
  git runs, such as `core.fsmonitor`). With `museSpark.modelApiHooks` on,
  hook commands (yours, your administrator's and the project's) run only in
  a trusted workspace. The settings that choose what runs and what is
  billed (`museBinaryPath`, `environmentVariables`, `backend`,
  `shellSandbox`, `sandboxNetwork`, `initialPermissionMode`,
  `allowDangerouslySkipPermissions`, `modelApiHooks`,
  `modelApiPromptCacheRetention`, the verify loop's `checkCommands`,
  `formatOnEdit` and `diagnosticsAfterEdits`, and the five paid
  `modelApi*` features) are machine-scoped in every workspace, trusted or
  not: a repository's
  `.vscode/settings.json` cannot point the extension at its own executable. In a remote window a dev container
  definition can write machine settings, so there Bypass permissions is
  never the starting mode and needs an explicit confirmation.
- **Programs the extension starts.** git, PowerShell, bash and the Muse
  Code CLI are found by absolute path only: an empty or relative `PATH`
  entry (which means the working directory, the workspace) is never
  searched, and `museBinaryPath` must be absolute.
- **Path confinement (Model API backend).** Every path a tool names is
  resolved through the file system (links, junctions and short names)
  before it is read or written, and refused when it leaves the workspace;
  the search worker skips any listed file that does. Edit Review and the
  rewind apply the same check before writing a file back. Windows names
  that would be reinterpreted are refused: alternate data streams
  (`a.txt:x`), device names (`NUL`, `COM1`), trailing dots or spaces.
- **Protected writes (Model API backend).** Writing `.git/**`, `.husky/**`,
  `.vscode/**`, `.idea/**`, `.devcontainer/**`, `.github/workflows/**`,
  `.agents/**`, `.muse/**`, `AGENTS.md`, `CLAUDE.md`, `.envrc` or
  `.gitmodules`, at any depth and in any letter case, shows an approval card
  in every mode but Bypass (Plan refuses it), and no "always allow" rule
  covers it. The one exception is a Markdown note written by the memory
  tools inside a memory folder, which is an ordinary edit. Muse Code flags
  its own protected writes, and "Edit automatically" never answers those
  for you.
- **Shell commands.** On the Model API backend the extension's own shell
  tool runs the command as an argument array through PowerShell or bash,
  never as a shell string, in the workspace root, with a timeout and an
  output cap, and only after the user's approval in the modes that ask. On
  the Muse Code CLI backend the CLI runs the commands inside its OS sandbox
  where that is set up; `museSpark.shellSandbox` at `auto` starts the CLI
  without the sandbox for a Windows workspace under the user's profile
  (where the sandbox cannot enter), and `off` never sandboxes; both leave
  the approval cards in place.
- **Check commands and `then_run` (Model API backend).** The commands the
  extension runs after the agent's edits (`museSpark.checkCommands`,
  machine-scoped, none by default) and the one an edit's `then_run` names
  take the shell tool's own hooks and permission path: the user's
  PreToolUse, PostToolUse and PostToolUseFailure hooks see each as a call
  of the shell tool (a denial, a rewrite or a demanded question holds), as
  does PermissionRequest wherever the shell's card would show; they ask wherever a shell command would ask (every mode
  but Bypass permissions), never run in Plan mode or Restricted Mode, and
  run with the shell tool's runner, job object and time cap. The agent can
  change what a check runs (a `package.json` script), which is why they
  ask; after the agent edits a file that decides what a command runs (the
  manifest, a `Makefile`, a tool's configuration, a file the command
  names), "Always allow in this session" no longer answers for it until the
  user's next message. Edited file names reach a check only as quoted
  arguments after `--`, and only files that exist in the workspace; a name
  that starts with `-` or `@` or holds a control character keeps the check
  from running, and on Windows so does one holding `"`, `&`, `|`, `<`, `>`,
  `^`, `%` or `!`, which Windows PowerShell 5.1's argument passing and
  `cmd.exe` (for a `.cmd` or `.bat` program) would read as syntax (measured:
  `x&echo.INJECTED` ran a second command through a `.cmd`). `then_run` runs
  only if the file still holds what the edit wrote.
- **Opening files for their diagnostics.** VS Code's language servers
  report only on files an editor shows, so the verify loop and the
  `getDiagnostics` tool open files. Opening a file can make an extension
  load its configuration as code (an ESLint or Prettier JavaScript config,
  `package.json`, `node_modules`), so neither ever opens or formats such a
  file, and once the agent writes one the loop opens and formats nothing
  more until the user's next message. `getDiagnostics` opens only a file
  inside the workspace by its real path (links and junctions resolved).
  Every later act on an edited file (format on edit's write-back, `then_run`,
  the diagnostics' show and read, a check's file arguments) uses the real
  path and canonical name confinement found at the edit and checks, just
  before, that the file is still there and still holds what the edit left
  (a check's arguments: still there). Format on edit's write-back is a
  conditional write: the file's bytes are compared with what the edit wrote
  immediately before the rename, and a changed file is left alone; a change
  landing between that comparison and the rename itself is the residual.
  Muse Code's own edits are not seen by the extension, so after Muse Code
  writes such a config, a later `getDiagnostics` request for an ordinary
  file can still open that file and let the extension load the config.
- **Installing Muse Code.** The panel runs only Meta's published install
  command for the platform (`constants.ts` `MUSE_INSTALL_COMMANDS`), and
  only after a confirmation that shows it, in a visible terminal. It never
  runs it silently or with arguments from the workspace.
- **Hooks (Model API backend).** Off by default and machine-scoped, and
  loaded only in a trusted workspace. Hook commands run as the user outside
  the agent sandbox, with an environment that excludes the Model API key
  and any `*_API_KEY`, standard input capped at 256 KiB, output capped at
  16 KiB, a timeout of at most 600 s, and the process tree ended on cancel.
  A hook can approve an ordinary tool call but never a paid call or a
  protected write: a paid call always reaches the paid-use popup, unless
  the user allowed that feature always in this (trusted) workspace, and a
  paid image aimed at a protected path asks even then.
- **MCP servers (Model API backend).** Started only in a trusted
  workspace. A local server sees only an allow-listed part of VS Code's
  environment plus its own `env`; the Model API key is never passed. On
  Windows each stdio server runs in a job object that ends its descendants.
  Remote error bodies and authentication challenges stay out of tool
  errors and logs.
- **Webview.** `default-src 'none'`, a per-load script nonce, no remote
  origins, no inline styles; every message between the host and the
  webview is validated against a schema.
- **Prompt injection.** Workspace files, rules and skills reach the model by
  design in a trusted workspace; the permission modes and the approval
  cards are the control, and the Diagnostics report and the log show what
  ran.
- **Release pipeline.** A tag is released only when it names the manifest
  version and points at a commit on `main`; the Marketplace PAT reaches one
  step, after an install that runs no package scripts; no checkout keeps a
  token; every job has a timeout.
- **The macOS dictation helper** is ad-hoc signed, not notarised (owner
  decision); VS Code's installer does not quarantine it, so Gatekeeper does
  not assess it.

More detail: `docs/PRIVACY.md` and PLAN.md §9.
