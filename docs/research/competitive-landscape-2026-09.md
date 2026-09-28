# Coding agents compared, September 2026

Research for PLAN.md D49, done 2026-09-27. It used public pages only: no
sign-in, no spend. Five read-only research passes covered:

- Claude Code: CLI, IDE extensions, web, SDK.
- NVIDIA's SoL-Pi.
- OpenAI Codex, Gemini CLI and Jules.
- The open-source field and the other named agents.
- An inventory of this extension.

The findings below list their sources. A claim marked _(secondary)_ came
only from a third-party write-up.

## The field in one paragraph each

**Claude Code** (code.claude.com, changelog 2.1.269–2.1.283):

- Tools: edit, shell, glob/grep, web search/fetch, notebooks, a Chrome
  extension and computer use.
- Control: plan mode, todos, checkpoints and `/rewind`.
- Extensibility: permission rules, hooks, skills, plugins with
  marketplaces and `claude plugin eval`, subagents and custom agents,
  output styles, a status line.
- Parallel and background: agent teams, worktrees, workflows, goals,
  routines (cloud), Remote Control.
- Surfaces: Slack (Claude Tag), desktop, mobile.
- Providers and enterprise: Bedrock, Vertex and Foundry, managed settings,
  OTel, ZDR.
- Reviews: `/code-review` and the GitHub and GitLab integrations.

**OpenAI Codex** (developers.openai.com/codex, CLI 0.157):

- Sandbox and approvals: an OS-native sandbox on all three OSes;
  permission profiles (deny-read globs, a domain-filtered network proxy);
  an **auto-review** agent that decides sandbox crossings, with a circuit
  breaker; Starlark command rules that carry their own tests.
- Long-running work: `/plan` then implement in a fresh context, `/goal`
  with a token budget, `/side` and `/fork`.
- Extensibility: subagents with custom TOML agents, 12-event hooks, skills
  and plugins, `/import` from Claude Code and Cursor.
- Review: `/review` presets (base branch, uncommitted, commit), and a
  review pane that stages or reverts by hunk and takes inline comments.
- Cloud: tasks with best-of-N attempts and `codex apply`, GitHub and
  GitLab PR review, Security Review.
- Automation: `codex exec` JSONL and schema output, SDKs, a GitHub Action.
- Remote: control from a phone.

**Gemini CLI**, which Antigravity CLI is replacing for consumers:

- Shadow-git checkpoints with `/restore`.
- A TOML policy engine, many sandbox backends, ACP, A2A remote agents.

**Jules**:

- An asynchronous agent that plans, codes and opens a PR, with a Critic
  pass and a CI Fixer.

**OpenCode** (opencode.ai, sst/opencode, MIT):

- Verification: LSP diagnostics fed back to the agent (30+ languages), and
  formatters after each edit.
- Agents and approvals: Build/Plan agents, glob permission rules with a
  `doom_loop` guard, git-snapshot `/undo` and `/redo`, read-only `explore`
  and `scout` subagents.
- Platform: an HTTP server behind the TUI, web and desktop apps; ACP;
  75+ providers.
- Collaboration: `/share`, `opencode pr`, a GitHub Action (`/oc`),
  per-project `stats`.

**OpenClaw** (openclaw/openclaw) is a self-hosted personal agent, not a
coding agent. It drives Claude Code, Codex and OpenCode over ACP from
chat apps. It is strong on memory: daily notes promoted into MEMORY.md,
hybrid search, and a memory flush before compaction. It also fails over
between auth profiles and models, and shows `/usage` per reply. The
name "open claws" may instead mean **Claw Code**, a clean-room rewrite
of Claude Code.

**T3 Code** (pingdotgg/t3code, MIT) is a GUI over other agents (Codex,
Claude Code, OpenCode, …):

- A hidden git checkpoint after every turn, and revert of files plus the
  provider's conversation.
- Diff review by turn or branch, with line comments sent to the agent.
- One click to commit, push and open a PR, with PR status per thread.
- Parallel threads in worktrees, a dev-server preview panel.
- Mobile apps and a relay; a cost dashboard with cache savings.

**Others**, what each does distinctively:

- **Aider**: repo map (tree-sitter and PageRank), architect/editor model
  split, `--lint-cmd` and `--test-cmd` auto-fix, `--watch-files`.
- **Cline**: checkpoints that restore files, task, or both.
- **Cursor**: best-of-N models in worktrees, Bugbot plus Autofix, a
  browser tool.
- **Zed**: per-hunk accept or reject in a multi-file review, "follow the
  agent".
- **Kilo**: line comments in chat, model-vs-model comparison.
- **Amp**: an Oracle second-opinion subagent, `/handoff` instead of
  compaction.
- **Factory**: Missions (orchestrated multi-feature work), spec mode
  saving the plan.
- **Copilot**: the coding agent reviews its own work and runs CodeQL,
  secret and dependency scans before its PR.
- **Goose**: YAML recipes.
- **Crush**: switch models mid-session.

Roo Code shut down in May 2026. Continue was acqui-hired by Cursor in
June 2026 _(secondary)_.

## SoL-Pi

(github.com/NVlabs/SoL-Pi, MIT, arXiv 2609.20519, 2026-09-17.)

SoL-Pi is an add-on to the open-source Pi agent. It adds four opt-in
mechanisms, found by an automated research loop with fixed capability
floors and a held-out task split:

- **ObservationPack**: a tool result over 10 KiB is sent whole twice, then
  replaced in the request by a placeholder (id, size, first and last
  lines). `obs_recall` pages the original back. Originals are archived by
  hash, and history is never rewritten.
- **Action Fusion**: `edit`/`write` take `then_run`. The edit is applied
  and the check command runs in one tool call, guarded by a hash and a
  per-file queue.
- **Online Context Compact**: compaction is considered only when a plan
  step completes. Its economics are
  breakeven = cache-write cost ÷ (archived − memo tokens), against the
  expected remaining requests. A hidden "rebuild your plan" turn follows.
- **Evidence-Preserving Reducer**: a cheap model condenses long test and
  build logs into a receipt of exact quotes. The receipt is validated,
  and falls back to the raw log on any failure.

Results on EdgeBench, 40 held-out tasks, with GPT-5.6 Sol:

| Harness                       | Tokens | Cost   | Score |
| ----------------------------- | ------ | ------ | ----- |
| Pi                            | 2.154B | $1,339 | 44.83 |
| SoL-Pi                        | −49 %  | $894   | 42.00 |
| SoL-Pi, ObservationPack alone | –      | $1,271 | 47.21 |
| Codex                         | 3.054B | $1,787 | 34.74 |

Elsewhere:

- On Claude Opus 5: −33.5 % cost at 42.22 vs 44.76.
- It is weaker on Terminal-Bench 4, solving 15 tasks against 18.
- Independent users report −8 % to −21 % tokens.
- Action Fusion's use depends on the model: DeepSeek 5/5, MiniMax 0/5.

What transfers:

- All four mechanisms fit this extension's Model API harness, which
  builds every request's input itself.
- The Muse Code CLI offers no such hook.
- The logic files port cleanly under MIT (keep the NVIDIA notice):
  `economics.ts`, `receipt.ts`, `observation.ts`, `file-queue.ts`,
  `then-run.ts`.

## Where this extension stands

**At or near parity** on:

- Subagents and the Agent map.
- Hooks: 17 events on the Model API.
- MCP and skills.
- Goals with a token budget.
- Scheduled prompts.
- Rewind: of code, and of the conversation.
- Side chat.
- Worktrees.
- Shared memory.
- Compaction.
- Permission modes with exact-command rules.
- Plan mode.
- Background tasks and `!` shell.
- Images and PDFs as input.
- Web search.
- Image generation.
- Voice.
- Proxies and certificates.
- An ACP agent for other editors (pending PR #32).

**Ahead of most** on:

- Consent before every paid use (D48).
- 15 display languages.
- A WCAG 2.2 AA gate.
- Machine-scoped settings a repository cannot turn on.
- Two backends that are never mixed.

**Behind the field**, ranked by what matters most for coding:

1. The model does not see the effects of its edits (diagnostics, lint,
   tests) unless it asks; nothing runs a check after an edit.
2. No code-intelligence tools. The model has only text search: no
   definitions, references, symbols or rename.
3. No web fetch on either backend (M44b is planned; Muse Code's
   `web_fetch` is switched off).
4. No review workflow. There is no `/review`, no per-hunk accept or
   reject, and no line comments sent to the agent.
5. No git/PR flow: commit message, push, PR, PR status.
6. Checkpoints do not cover untracked files or turn boundaries, and
   there is no redo.
7. No context-efficiency mechanisms (SoL-Pi's), and compaction is manual
   only.
8. No custom agents, and no built-in read-only explore or reviewer
   agent.
9. Auto on the Model API has no safety reviewer, and there are no
   command rules or permission profiles.
10. No parallel-session board and no best-of-N.
11. No headless or CI mode.
12. No browser check of a web app's change.
13. Small gaps:
    - notifications;
    - per-reply usage;
    - a session budget cap;
    - broader import (MCP servers, hooks, agents) from Claude Code and
      Codex;
    - JSON session export and import.

On the Muse Code backend these are bounded by MSP. But the extension's
`ide` MCP server, which every Muse Code session loads, can offer several
of them there too: code intelligence, web fetch and browser checks.
Everything that lives in the extension itself serves both backends: the
review pane, git/PR, checkpoints, the board, notifications.

## TypeSafe (read 2026-09-27)

[docs.typesafe.ai](https://docs.typesafe.ai/introduction) sells Jev, a "System One" model. It takes text
and typed questions (Choice, Score, Noul) and returns calibrated
probabilities and a confidence. It does not generate text or code, and its
own docs say it is no replacement for a coding agent's model.

- **Terms:** $0.042 per million input tokens, output free; 64k tokens per
  request; 1,200 requests a minute; text only.
- **Weak spots:** literal reading, math and dates, adversarial content.

PLAN.md D50 and M85 take it only as an opt-in assist to the Muse model: skill
suggestion first, then an Auto risk score beside the command rules.
