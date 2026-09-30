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
  `allowDangerouslySkipPermissions`, `modelApiHooks`, `modelApiRepoMap`,
  `modelApiPromptCacheRetention` and the five paid `modelApi*` features)
  are machine-scoped in every workspace, trusted or not: a repository's
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
- **Code intelligence (both backends).** The file a code intelligence tool
  is asked about is confined the same way, and a result VS Code's language
  service returns from outside the workspace (a library's declarations,
  another folder, a file reached through a link that leaves it) is left out
  and counted: its location and lines are never shown. A hover shows what a
  declaration says, so a hover for a symbol defined only outside the
  workspace is held back, unless the definition is in a language's library
  inside VS Code's installation or an extension's folder. What a language
  service infers still flows through: a symbol defined in the workspace
  whose type comes from a file outside it (an import from `../`, a
  `tsconfig` path) shows that type in its hover and its diagnostics, as it
  does in the editor. `rename_symbol` refuses a rename that would touch any
  file outside the workspace, create, move or delete files (seen through
  the edit's internal entry list, since VS Code's API lists only text
  edits; an edit that does not show its list is refused too), or change a
  file with unsaved changes, one VS Code holds differently from the disk,
  or one whose edit ranges no longer cover the old name (an edit the service
  made from an older version of the file). On the Model API backend it asks
  as an edit (a protected write when any of its files is one, named first on
  the card), and every file is confined and read again after the card and
  once more right before its own write, so nothing a formatter, a hook or
  the user wrote meanwhile is overwritten; a Stop before the first write
  writes nothing. On the Muse Code backend the `ide` server's tools change
  nothing and declare themselves read-only; its rename returns the edits for
  Muse Code's own edit tool, and Muse Code 1.4.0 asks its own card for these
  tools in its on-request mode. The repo map reaches the Model API's
  instructions only in a trusted workspace.
- **Protected writes (Model API backend).** Writing `.git/**`, `.husky/**`,
  `.vscode/**`, `.idea/**`, `.devcontainer/**`, `.github/workflows/**`,
  `.agents/**`, `.muse/**`, `AGENTS.md`, `CLAUDE.md`, `.envrc` or
  `.gitmodules`, at any depth and in any letter case, shows an approval card
  in every mode but Bypass (Plan refuses it), and no "always allow" rule
  covers it. The one exception is a Markdown note written by the memory
  tools inside a memory folder, which is an ordinary edit. Muse Code flags
  its own protected writes, and "Edit automatically" never answers those
  for you.
- **Saved plans (both backends).** **Save plan** is the extension's own
  write to `.agents/plans/`, and it asks in a modal first, as a protected
  write does. It creates a new file by a hard link from a hidden stage, so
  it never replaces a file. The plans folder must be the workspace's own
  `.agents/plans`: a link or junction to anywhere else is refused, and the
  folder is checked again after it is made and just before the link, so
  one swapped for a junction after the check is refused too (memory notes
  get the same re-check). A file system without hard links refuses the
  save rather than risk replacing a file. Restricted Mode refuses both
  saving a plan and implementing one.
- **A plan file is untrusted content.** Anything in `.agents/plans/` may
  have been written by a cloned repository or a tool, so a plan picked
  from **Plans…** starts a conversation in Manual (Plan when that is the
  starting mode), whatever `initialPermissionMode` says, and the model is
  told nobody confirmed who wrote it. Only a reply saved from a Plan-mode
  turn of the conversation on screen is sent as the plan the user
  approved; even then Bypass is never the starting mode in a remote
  window. What the model gets is what the panel showed, by construction:
  a plan reply is rendered, and its brief written, from one rewritten
  Markdown tree in which a link's destination, a picture's source, a
  title, a definition, a footnote and a code fence's info string are all
  shown text. Raw HTML, which the panel never renders, is the exception: a
  reply holding it is saved with a warning and not started. A control or
  format character (a direction override, a zero-width character, DEL or a
  C1 control) makes the panel paint text otherwise than the model reads
  it, so a reply or a plan file holding one is neither saved nor started.
- **Shell commands.** On the Model API backend the extension's own shell
  tool runs the command as an argument array through PowerShell or bash,
  never as a shell string, in the workspace root, with a timeout and an
  output cap, and only after the user's approval in the modes that ask. On
  the Muse Code CLI backend the CLI runs the commands inside its OS sandbox
  where that is set up; `museSpark.shellSandbox` at `auto` starts the CLI
  without the sandbox for a Windows workspace under the user's profile
  (where the sandbox cannot enter), and `off` never sandboxes; both leave
  the approval cards in place.
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
- **Web fetch (both backends).** The model can ask the extension to read a
  page. Only `https://` URLs without credentials, of at most 2,048
  characters, on public internet addresses: the name is resolved on the
  user's machine and refused when any answer is loopback, private,
  link-local, carrier-grade NAT, a cloud metadata address or reserved
  (IPv4 carried inside IPv6, the network's own NAT64 prefix included, is
  judged as IPv4; while that prefix cannot be learned, no IPv6 answer is
  used), and local or reserved names, with any trailing dots, are
  refused before any lookup. The connection is pinned to the checked
  addresses, raced as RFC 8305 says (TLS verifies the name); through a proxy
  the tunnel is asked for that address, and only an answer that arrived over
  TLS is read. Same-host redirects are checked and pinned again (at most
  five); another host's is handed back to the model, which asks again.
  5 MiB after decompression, 30 seconds, text types only. HTML is parsed
  by parse5 on a worker thread per page (at most two at once) stopped at
  10 seconds or 512 MiB, its output bounded; only what is never page text
  by structure (scripts, styles, template content, `<noscript>`, embedded
  media, form controls, SVG, MathML) is left out, and no rendering is
  emulated, so the model gets the page's text as served, including text a
  stylesheet, a hiding attribute or a script would keep off screen, all of
  it marked untrusted; XHTML is refused. On the Model API backend each host asks in
  every mode but Bypass (Plan refuses), and a `PermissionRequest` hook's
  allow does not replace that card; on Muse Code the `ide` tool is listed
  only in a trusted workspace without `sandboxNetwork: restricted`, carries
  `readOnlyHint: false, openWorldHint: true`, the extension asks before
  every call, and a call Muse Code stops waiting for (its request closed, or
  `notifications/cancelled`) fetches nothing more. The page reaches the model
  between random markers as untrusted content; only short tokens of what a
  server sent appear outside them. Residual risk: an intranet service on a
  public address looks like the internet, the URL itself can carry
  conversation text to the host the user approved, and the proxy decides
  for the address, not the name (PLAN.md §9).
- **Webview.** `default-src 'none'`, a per-load script nonce, no remote
  origins, no inline styles; every message between the host and the
  webview is validated against a schema.
- **Prompt injection.** Workspace files, rules and skills reach the model by
  design in a trusted workspace, and so do fetched web pages (marked as
  untrusted content); the permission modes and the approval cards are the
  control, and the Diagnostics report and the log show what ran.
- **Release pipeline.** A tag is released only when it names the manifest
  version and points at a commit on `main`; the Marketplace PAT reaches one
  step, after an install that runs no package scripts; no checkout keeps a
  token; every job has a timeout.
- **The macOS dictation helper** is ad-hoc signed, not notarised (owner
  decision); VS Code's installer does not quarantine it, so Gatekeeper does
  not assess it.

More detail: `docs/PRIVACY.md` and PLAN.md §9.
