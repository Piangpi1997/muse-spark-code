// The verify loop on the Model API backend (M68, PLAN.md D49), over the
// fake Model API: a fixture whose check fails, the diagnostics and check
// results in the next request, the bounded fix loop, the shell permission
// path per mode, run_checks, then_run with its guard, and format on edit.

import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, ItemSnapshot } from '../../src/shared/agentEvents'
import {
  CHECK_FIX_MAX_ROUNDS,
  type CheckCommandSetting,
  MODEL_TEXT,
  SHELL_DEFAULT_TIMEOUT_MS,
  UI_TEXT,
} from '../../src/shared/constants'
import { fill, plural } from '../../src/shared/l10n/text'
import { ModelApiHost, type ModelApiSession } from '../../src/core/backends/modelapi/ModelApiHost'
import type { ShellResult } from '../../src/core/backends/modelapi/tools'
import type { VerifyHooks } from '../../src/core/backends/modelapi/verifyLoop'
import type { DiagnosticEntry } from '../../src/core/diagnostics'
import type { EditedFile, FileDiagnostics } from '../../src/core/verify/diagnosticsReport'
import type { ApprovalMode } from '../../src/shared/permissionModes'
import { FakeLogOutputChannel } from './helpers/fakes'
import {
  FAKE_MODEL_API_ACCOUNT_ID,
  fakeModelApi,
  fakeModelApiClient,
  type ScriptedCall,
  type ScriptedReply,
} from './helpers/fakeModelApi'
import { memoryContextIo } from './helpers/fakeContextIo'
import { type MemoryToolIo, memoryToolIo } from './helpers/fakeToolIo'
import { logLines } from './helpers/logText'

const ROOT = '/ws'
const LINT: CheckCommandSetting = { name: 'lint', command: 'npm run lint', changedFiles: true }
const TEST: CheckCommandSetting = { name: 'test', command: 'npm test' }

function passed(stdout = 'ok'): ShellResult {
  return { stdout, stderr: '', exitCode: 0, isTimedOut: false, isCancelled: false }
}

function failed(stdout: string): ShellResult {
  return { stdout, stderr: '', exitCode: 1, isTimedOut: false, isCancelled: false }
}

/** The fixture's shell: lint fails until `isFixed` says so; every other command passes. */
function lintShell(isFixed: () => boolean = () => false): (command: string) => ShellResult {
  return (command) =>
    command.startsWith(LINT.command) && !isFixed()
      ? failed('src/a.ts:1:7 error no-unused-vars')
      : passed(`ran ${command}`)
}

interface SetupOptions {
  readonly files?: Record<string, string>
  readonly checks?: readonly CheckCommandSetting[]
  readonly isDiagnosticsOn?: boolean
  readonly isFormatOnEdit?: boolean
  readonly isTrusted?: boolean
  readonly platform?: NodeJS.Platform
  readonly shell?: (command: string) => ShellResult
  readonly diagnostics?: (files: readonly EditedFile[]) => Promise<readonly FileDiagnostics[]>
  readonly format?: (absolutePath: string, text: string) => Promise<string | undefined>
  readonly io?: MemoryToolIo
  readonly hasVerify?: boolean
}

function setup(options: SetupOptions = {}) {
  const api = fakeModelApi()
  const log = new FakeLogOutputChannel()
  const io =
    options.io ??
    memoryToolIo(options.files ?? { 'src/a.ts': 'const a = 1\n' }, ROOT, options.shell)
  const diagnosticsCalls: (readonly EditedFile[])[] = []
  const formatCalls: string[] = []
  const verify: VerifyHooks = {
    isDiagnosticsOn: () => options.isDiagnosticsOn ?? true,
    checkCommands: () => options.checks ?? [],
    isFormatOnEdit: () => options.isFormatOnEdit ?? false,
    diagnosticsAfterEdit: async (files) => {
      diagnosticsCalls.push(files)
      return await (options.diagnostics?.(files) ??
        Promise.resolve(files.map((file) => ({ file, entries: [] }))))
    },
    formatAfterEdit: async (absolutePath, text) => {
      formatCalls.push(absolutePath)
      return await (options.format?.(absolutePath, text) ?? Promise.resolve(undefined))
    },
  }
  let ids = 0
  let clock = 1_000_000
  const host = new ModelApiHost({
    client: fakeModelApiClient(api, log),
    workspaceRoot: ROOT,
    platform: options.platform ?? 'linux',
    io,
    contextIo: memoryContextIo(io.files),
    newId: () => {
      ids += 1
      return `id${String(ids)}`
    },
    now: () => {
      clock += 1000
      return clock
    },
    log,
    personalSkillsRoot: undefined,
    isWorkspaceTrusted: () => options.isTrusted ?? true,
    getAccountId: () => Promise.resolve(FAKE_MODEL_API_ACCOUNT_ID),
    describeEnvironment: () => Promise.resolve({ git: undefined }),
    isPaidFeatureOn: () => false,
    notePaidUse: () => undefined,
    promptCacheRetention: () => 'in_memory',
    allowsPaidUse: () => Promise.resolve(false),
    isPaidUseRemembered: () => false,
    noteSubagentUsage: () => undefined,
    memory: undefined,
    ...(options.hasVerify !== false && { verify }),
  })
  return { api, host, io, log, diagnosticsCalls, formatCalls }
}

type Setup = ReturnType<typeof setup>

/** The choice a test gives each card: allow once unless it says otherwise. */
type Answer = (
  request: Extract<AgentEvent, { type: 'approvalRequested' }>,
) => 'allow_once' | 'allow_session' | 'abort' | 'hold'

async function start(
  t: Setup,
  mode: ApprovalMode,
  answer: Answer = () => 'allow_once',
): Promise<{
  session: ModelApiSession
  events: AgentEvent[]
  cards: Extract<AgentEvent, { type: 'approvalRequested' }>[]
  turn: (text?: string) => Promise<void>
}> {
  const session = (await t.host.startSession({
    workspaceRoot: ROOT,
    modelId: 'muse-spark-1.3',
    approvalMode: mode,
  })) as ModelApiSession
  const events: AgentEvent[] = []
  const cards: Extract<AgentEvent, { type: 'approvalRequested' }>[] = []
  let done = Promise.withResolvers<undefined>()
  const decide = (event: Extract<AgentEvent, { type: 'approvalRequested' }>) => {
    cards.push(event)
    const choice = answer(event)
    if (choice === 'hold') {
      return
    }
    queueMicrotask(() => {
      void session.decideApproval({
        approvalId: event.approvalId,
        choiceId: choice,
        requirementId: event.requirementId,
      })
    })
  }
  session.onEvent((event) => {
    events.push(event)
    if (event.type === 'approvalRequested') {
      decide(event)
    } else if (event.type === 'turnCompleted') {
      done.resolve(undefined)
      done = Promise.withResolvers<undefined>()
    }
  })
  return {
    session,
    events,
    cards,
    turn: async (text = 'fix it') => {
      const finished = done.promise
      await session.sendTurn([{ type: 'text', text }])
      await finished
    },
  }
}

function editCall(find: string, replace: string, thenRun?: string): ScriptedCall {
  return {
    name: 'edit_file',
    arguments: JSON.stringify({
      path: 'src/a.ts',
      find,
      replace,
      ...(thenRun !== undefined && { then_run: thenRun }),
    }),
  }
}

function writeCall(path: string, content: string, thenRun?: string): ScriptedCall {
  return {
    name: 'write_file',
    arguments: JSON.stringify({
      path,
      content,
      ...(thenRun !== undefined && { then_run: thenRun }),
    }),
  }
}

/** The text of every user message in a request, joined. */
function userText(body: Record<string, unknown> | undefined): string {
  const input = (body?.['input'] ?? []) as readonly {
    readonly type?: string
    readonly role?: string
    readonly content?: readonly { readonly text?: string }[]
  }[]
  return input
    .filter((item) => item.type === 'message' && item.role === 'user')
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? '')
    .join('\n')
}

/** Every function output the request carried, in order. */
function outputs(body: Record<string, unknown> | undefined): readonly string[] {
  const input = (body?.['input'] ?? []) as readonly {
    readonly type?: string
    readonly output?: unknown
  }[]
  return input
    .filter((item) => item.type === 'function_call_output')
    .map((item) => (typeof item.output === 'string' ? item.output : JSON.stringify(item.output)))
}

function completedRows(events: readonly AgentEvent[], tool: string): readonly ItemSnapshot[] {
  return events.flatMap((event) =>
    event.type === 'itemCompleted' && event.item.tool === tool ? [event.item] : [],
  )
}

/** `rounds` replies that each write a new file, then a closing reply. */
function scriptWriteRounds(t: Setup, rounds: number, closing: string): void {
  t.api.script(
    ...Array.from({ length: rounds }, (_, index): ScriptedReply => ({
      calls: [writeCall(`src/f${String(index)}.ts`, `export const x = ${String(index)}\n`)],
    })),
    { text: closing },
  )
}

/** Sends a turn that stops at its first card, and waits for it to end. */
async function stopAtFirstCard(
  started: Awaited<ReturnType<typeof start>>,
  t: Setup,
  call: ScriptedCall,
): Promise<void> {
  const { session, events, turn } = started
  t.api.script({ calls: [call] }, { text: 'never' })
  const finished = turn()
  await vi.waitFor(() => {
    expect(events.some((event) => event.type === 'approvalRequested')).toBe(true)
  })
  await session.cancel()
  await finished
  expect(t.io.shellCalls).toEqual([])
}

function toolNames(body: Record<string, unknown> | undefined): readonly string[] {
  const tools = (body?.['tools'] ?? []) as readonly { readonly name?: string }[]
  return tools.flatMap((tool) => (tool.name === undefined ? [] : [tool.name]))
}

const TYPE_ERROR: DiagnosticEntry = {
  path: undefined,
  severity: 'error',
  line: 1,
  column: 7,
  message: "Type 'string' is not assignable to type 'number'.",
  source: 'ts',
}

describe('the verify loop after a round of edits (Model API)', () => {
  it('sends the diagnostics and the check results in the next request, and shows a row', async () => {
    const t = setup({
      checks: [LINT, TEST],
      shell: lintShell(),
      diagnostics: (files) =>
        Promise.resolve(files.map((file) => ({ file, entries: [TYPE_ERROR] }))),
    })
    const { events, turn } = await start(t, 'allowAll')
    t.api.script({ calls: [editCall('1', "'1'")] }, { text: 'done' })
    await turn()
    expect(t.io.shellCalls).toEqual([
      { command: "npm run lint -- 'src/a.ts'", cwd: ROOT, timeoutMs: 300_000 },
      { command: 'npm test', cwd: ROOT, timeoutMs: 300_000 },
    ])
    expect(t.diagnosticsCalls).toEqual([[{ relative: 'src/a.ts', absolute: `${ROOT}/src/a.ts` }]])
    const next = userText(t.api.responseBodies()[1])
    expect(next).toContain(MODEL_TEXT.verifyLead)
    expect(next).toContain('src/a.ts: errors 1, warnings 0')
    expect(next).toContain(
      "src/a.ts:1:7: error: Type 'string' is not assignable to type 'number'. [ts]",
    )
    expect(next).toContain(
      "lint: failed\n$ npm run lint -- 'src/a.ts'\nsrc/a.ts:1:7 error no-unused-vars\n[exit code 1]",
    )
    expect(next).toContain('test: passed\n$ npm test\nran npm test\n[exit code 0]')
    const [row] = completedRows(events, 'verify_edits')
    expect(row).toMatchObject({
      status: 'completed',
      args: JSON.stringify({ paths: ['src/a.ts'] }),
      verifySummary: {
        files: ['src/a.ts'],
        errors: 1,
        warnings: 0,
        checks: [
          { name: 'lint', outcome: 'failed' },
          { name: 'test', outcome: 'passed' },
        ],
      },
    })
    // The model reads the same as the row, behind the untrusted-data lead.
    expect(next).toContain(row?.visibleOutput ?? 'missing')
  })

  it('checks nothing after a round without edits, and nothing at all without the loop', async () => {
    const t = setup({ checks: [LINT] })
    const { events, turn } = await start(t, 'allowAll')
    t.api.script(
      { calls: [{ name: 'read_file', arguments: '{"path":"src/a.ts"}' }] },
      { text: 'ok' },
    )
    await turn()
    expect(completedRows(events, 'verify_edits')).toEqual([])
    const bare = setup({ hasVerify: false })
    const second = await start(bare, 'allowAll')
    bare.api.script({ calls: [editCall('1', '2')] }, { text: 'ok' })
    await second.turn()
    expect(completedRows(second.events, 'verify_edits')).toEqual([])
    expect(toolNames(bare.api.responseBodies()[0])).not.toContain('run_checks')
  })

  it('says when the diagnostics cannot be read instead of reporting the files clean', async () => {
    const t = setup({ diagnostics: () => Promise.reject(new Error('no language server')) })
    const { events, turn } = await start(t, 'allowAll')
    t.api.script({ calls: [editCall('1', '2')] }, { text: 'ok' })
    await turn()
    expect(userText(t.api.responseBodies()[1])).toContain(
      fill(MODEL_TEXT.verifyDiagnosticsUnavailable, { reason: 'no language server' }),
    )
    const [row] = completedRows(events, 'verify_edits')
    expect(row?.verifySummary).toEqual({ files: ['src/a.ts'], checks: [] })
    expect(logLines(t.log).join('\n')).toContain('the diagnostics could not be read')
  })

  it('stops the fix loop after its limit of failing rounds, and says so to both', async () => {
    const t = setup({ checks: [LINT], shell: lintShell() })
    const { events, turn } = await start(t, 'allowAll')
    const rounds = CHECK_FIX_MAX_ROUNDS + 2
    scriptWriteRounds(t, rounds, 'gave up')
    await turn()
    const lintRuns = t.io.shellCalls.filter((call) => call.command.startsWith(LINT.command))
    expect(lintRuns).toHaveLength(CHECK_FIX_MAX_ROUNDS)
    const stopNote = fill(MODEL_TEXT.checksStopped, { count: String(CHECK_FIX_MAX_ROUNDS) })
    expect(userText(t.api.responseBodies()[CHECK_FIX_MAX_ROUNDS - 1])).not.toContain(stopNote)
    expect(userText(t.api.responseBodies()[CHECK_FIX_MAX_ROUNDS])).toContain(stopNote)
    const notices = events.filter((event) => event.type === 'backendNotice')
    expect(notices).toEqual([
      {
        type: 'backendNotice',
        level: 'warning',
        text: plural(UI_TEXT.checksStoppedNotice, CHECK_FIX_MAX_ROUNDS),
      },
    ])
    // The diagnostics go on after the checks stop.
    const rows = completedRows(events, 'verify_edits')
    expect(rows).toHaveLength(rounds)
    expect(rows.at(-1)?.verifySummary?.checks).toEqual([])
    // A new turn starts the count again.
    t.api.script({ calls: [writeCall('src/g.ts', 'x\n')] }, { text: 'again' })
    await turn('once more')
    expect(t.io.shellCalls.filter((call) => call.command.startsWith(LINT.command))).toHaveLength(
      CHECK_FIX_MAX_ROUNDS + 1,
    )
  })

  it('counts only rounds in a row: a passing round resets the fix loop', async () => {
    let lintRun = 0
    const t = setup({
      checks: [LINT],
      shell: (command) => {
        lintRun += 1
        // fail, pass, then fail every time.
        return lintRun === 2 ? passed(command) : failed('still broken')
      },
    })
    const { events, turn } = await start(t, 'allowAll')
    // One failing round, one passing, then failing ones until the limit.
    const rounds = CHECK_FIX_MAX_ROUNDS + 2
    scriptWriteRounds(t, rounds, 'done')
    await turn()
    expect(lintRun).toBe(rounds)
    const stopNote = fill(MODEL_TEXT.checksStopped, { count: String(CHECK_FIX_MAX_ROUNDS) })
    // Without the reset the loop would have stopped after its third round.
    expect(userText(t.api.responseBodies()[CHECK_FIX_MAX_ROUNDS])).not.toContain(stopNote)
    expect(userText(t.api.responseBodies()[rounds - 1])).not.toContain(stopNote)
    expect(userText(t.api.responseBodies()[rounds])).toContain(stopNote)
    expect(events.filter((event) => event.type === 'backendNotice')).toHaveLength(1)
  })

  it('reports a shell that cannot start as a failed check, not a failed turn', async () => {
    const t = setup({
      checks: [LINT],
      shell: () => {
        throw new Error('spawn bash ENOENT')
      },
    })
    const { events, turn } = await start(t, 'allowAll')
    t.api.script({ calls: [editCall('1', '2', 'npm test')] }, { text: 'ok' })
    await turn()
    expect(events.find((event) => event.type === 'turnCompleted')).toMatchObject({
      terminal: 'completed',
    })
    const next = t.api.responseBodies()[1]
    expect(userText(next)).toContain('lint: failed')
    expect(userText(next)).toContain('spawn bash ENOENT')
    expect(outputs(next)[0]).toContain('spawn bash ENOENT\n[exit code unknown]')
    expect(completedRows(events, 'edit_file')[0]?.thenRun?.outcome).toBe('failed')
  })

  it('refuses a scoped check whose path would read as an option, running nothing', async () => {
    const t = setup({ files: {}, checks: [LINT] })
    const { events, turn } = await start(t, 'allowAll')
    t.api.script({ calls: [writeCall('-rf.ts', 'x\n')] }, { text: 'ok' })
    await turn()
    expect(t.io.shellCalls).toEqual([])
    expect(userText(t.api.responseBodies()[1])).toContain(
      fill(MODEL_TEXT.checkNotRun, { name: 'lint', reason: MODEL_TEXT.checkSkipUnsafePath }),
    )
    expect(completedRows(events, 'verify_edits')[0]?.verifySummary?.checks).toEqual([
      { name: 'lint', outcome: 'notRun', skip: 'unsafePath' },
    ])
  })

  it('stops with the turn: a Stop at a check card cancels the row and the turn', async () => {
    const t = setup({ checks: [LINT] })
    const started = await start(t, 'onRequest', () => 'hold')
    const { events } = started
    await stopAtFirstCard(started, t, editCall('1', '2'))
    expect(completedRows(events, 'verify_edits')[0]?.status).toBe('cancelled')
    expect(events.find((event) => event.type === 'turnCompleted')).toMatchObject({
      terminal: 'cancelled',
    })
    expect(t.api.responseBodies()).toHaveLength(1)
  })
})

// The plan's drill: an automatic check asks wherever a shell command asks.
describe('an automatic check takes the shell tool’s permission path, per mode', () => {
  it('asks in Manual, as the shell would (the edit asks too)', async () => {
    const t = setup({ checks: [LINT], shell: lintShell() })
    const { cards, turn } = await start(t, 'promptUnmatched')
    t.api.script({ calls: [editCall('1', '2')] }, { text: 'ok' })
    await turn()
    expect(cards.map((card) => card.subject)).toEqual([
      { kind: 'fileWrite', path: 'src/a.ts', toolName: 'edit_file' },
      { kind: 'shell', command: "npm run lint -- 'src/a.ts'" },
    ])
    expect(cards[1]?.toolName).toBe('bash')
    expect(
      cards[1]?.availableChoices.find((choice) => choice.choiceId === 'allow_session')?.label,
    ).toBe(`${UI_TEXT.allowSessionPrefix} npm run lint`)
    expect(t.io.shellCalls).toHaveLength(1)
  })

  it('asks in Auto, where edits run without a card', async () => {
    const t = setup({ checks: [LINT], shell: lintShell() })
    const { cards, turn } = await start(t, 'onRequest')
    t.api.script({ calls: [editCall('1', '2')] }, { text: 'ok' })
    await turn()
    expect(cards.map((card) => card.subject.kind)).toEqual(['shell'])
    expect(t.io.shellCalls).toHaveLength(1)
  })

  it('runs without a card only in Bypass permissions', async () => {
    const t = setup({ checks: [LINT], shell: lintShell() })
    const { cards, turn } = await start(t, 'allowAll')
    t.api.script({ calls: [editCall('1', '2')] }, { text: 'ok' })
    await turn()
    expect(cards).toEqual([])
    expect(t.io.shellCalls).toHaveLength(1)
  })

  it('never runs in Plan: the edit is refused, and run_checks runs nothing', async () => {
    const t = setup({ checks: [LINT, TEST] })
    const { cards, events, turn } = await start(t, 'denyUnmatched')
    t.api.script(
      { calls: [editCall('1', '2'), { name: 'run_checks', arguments: '{}' }] },
      { text: 'ok' },
    )
    await turn()
    expect(cards).toEqual([])
    expect(t.io.shellCalls).toEqual([])
    expect(completedRows(events, 'verify_edits')).toEqual([])
    const [, checksOutput] = outputs(t.api.responseBodies()[1])
    expect(checksOutput).toContain(
      fill(MODEL_TEXT.checkNotRun, { name: 'lint', reason: MODEL_TEXT.checkSkipRefused }),
    )
    expect(completedRows(events, 'run_checks')[0]?.verifySummary?.checks).toEqual([
      { name: 'lint', outcome: 'notRun', skip: 'refused' },
      { name: 'test', outcome: 'notRun', skip: 'refused' },
    ])
  })

  it('never runs in Restricted Mode: no checks after edits, no run_checks offered', async () => {
    const t = setup({ checks: [LINT], isTrusted: false })
    const { cards, events, turn } = await start(t, 'allowAll')
    t.api.script(
      { calls: [editCall('1', '2'), { name: 'run_checks', arguments: '{}' }] },
      { text: 'ok' },
    )
    await turn()
    expect(toolNames(t.api.responseBodies()[0])).not.toContain('run_checks')
    expect(cards).toEqual([])
    expect(t.io.shellCalls).toEqual([])
    // The diagnostics still come; the checks are left out.
    expect(completedRows(events, 'verify_edits')[0]?.verifySummary?.checks).toEqual([])
    expect(outputs(t.api.responseBodies()[1])[1]).toContain(MODEL_TEXT.checkSkipRestricted)
  })

  it('"Always allow in this session" works as it does for that command', async () => {
    const t = setup({ checks: [LINT], shell: lintShell() })
    const { cards, turn } = await start(t, 'onRequest', () => 'allow_session')
    t.api.script(
      { calls: [editCall('1', '2')] },
      { calls: [editCall('2', '3')] },
      // The model's own shell call of the same command is allowed by the same rule.
      { calls: [{ name: 'bash', arguments: '{"command":"npm run lint","description":"lint"}' }] },
      { text: 'ok' },
    )
    await turn()
    expect(cards).toHaveLength(1)
    expect(t.io.shellCalls.map((call) => call.command)).toEqual([
      "npm run lint -- 'src/a.ts'",
      "npm run lint -- 'src/a.ts'",
      'npm run lint',
    ])
  })

  it('does not ask again in the turn for a check the user rejected', async () => {
    const t = setup({ checks: [LINT] })
    const { cards, turn } = await start(t, 'onRequest', () => 'abort')
    t.api.script({ calls: [editCall('1', '2')] }, { calls: [editCall('2', '3')] }, { text: 'ok' })
    await turn()
    expect(cards).toHaveLength(1)
    expect(t.io.shellCalls).toEqual([])
    expect(userText(t.api.responseBodies()[1])).toContain(
      fill(MODEL_TEXT.checkNotRun, { name: 'lint', reason: MODEL_TEXT.checkSkipRejected }),
    )
  })
})

describe('run_checks (the model’s own call)', () => {
  it('is offered with the checks named, and runs the ones asked over the turn’s edits', async () => {
    const t = setup({ checks: [LINT, TEST], shell: lintShell(), isDiagnosticsOn: false })
    const { events, turn } = await start(t, 'allowAll')
    t.api.script(
      { calls: [{ name: 'run_checks', arguments: '{"names":["lint"]}' }] },
      { calls: [editCall('1', '2')] },
      { calls: [{ name: 'run_checks', arguments: '{"names":["lint"]}' }] },
      { calls: [{ name: 'run_checks', arguments: '{"names":["lint"],"paths":["src/b.ts"]}' }] },
      { text: 'ok' },
    )
    await turn()
    const definition = (
      t.api.responseBodies()[0]?.['tools'] as readonly Record<string, unknown>[]
    ).find((tool) => tool['name'] === 'run_checks')
    expect(String(definition?.['description'])).toContain(
      'lint (`npm run lint`), test (`npm test`)',
    )
    expect(t.io.shellCalls.map((call) => call.command)).toEqual([
      // Before any edit: the whole project.
      'npm run lint',
      // The automatic checks after the edit, every one configured.
      "npm run lint -- 'src/a.ts'",
      'npm test',
      // The turn's edits, then the path the model named.
      "npm run lint -- 'src/a.ts'",
      "npm run lint -- 'src/b.ts'",
    ])
    const [first] = completedRows(events, 'run_checks')
    expect(first).toMatchObject({
      status: 'completed',
      verifySummary: { files: [], checks: [{ name: 'lint', outcome: 'failed' }] },
    })
    expect(outputs(t.api.responseBodies()[1])[0]).toContain(MODEL_TEXT.runChecksLead)
  })

  it('refuses unknown names, bad arguments, paths outside the workspace, and no checks', async () => {
    const t = setup({ checks: [LINT] })
    const { turn } = await start(t, 'allowAll')
    t.api.script(
      {
        calls: [
          { name: 'run_checks', arguments: '{"names":["deploy"]}' },
          { name: 'run_checks', arguments: '{"names":"lint"}' },
          { name: 'run_checks', arguments: 'not json' },
          { name: 'run_checks', arguments: '{"paths":["../outside.ts"]}' },
        ],
      },
      { text: 'ok' },
    )
    await turn()
    const [unknown, badShape, notJson, outside] = outputs(t.api.responseBodies()[1])
    expect(unknown).toBe(
      `Error: ${fill(MODEL_TEXT.runChecksUnknown, { name: 'deploy', names: 'lint' })}`,
    )
    expect(badShape).toContain('Error: invalid arguments')
    expect(notJson).toBe('Error: arguments are not valid JSON')
    expect(outside).toContain('Error:')
    expect(t.io.shellCalls).toEqual([])
    const none = setup({ checks: [] })
    const second = await start(none, 'allowAll')
    none.api.script({ calls: [{ name: 'run_checks', arguments: '{}' }] }, { text: 'ok' })
    await second.turn()
    expect(outputs(none.api.responseBodies()[1])[0]).toBe(`Error: ${MODEL_TEXT.runChecksNone}`)
  })
})

describe('then_run: one call, two results', () => {
  it('runs the command after the edit and returns both results in one row', async () => {
    const t = setup({ isDiagnosticsOn: false, shell: () => failed('1 failing') })
    const { events, turn } = await start(t, 'allowAll')
    t.api.script({ calls: [editCall('1', '2', 'npm test -- a')] }, { text: 'ok' })
    await turn()
    expect(t.io.shellCalls).toEqual([
      { command: 'npm test -- a', cwd: ROOT, timeoutMs: SHELL_DEFAULT_TIMEOUT_MS },
    ])
    const [output] = outputs(t.api.responseBodies()[1])
    expect(output).toBe(
      `edited src/a.ts\n\n${MODEL_TEXT.thenRunLead} $ npm test -- a\n1 failing\n[exit code 1]`,
    )
    const [row] = completedRows(events, 'edit_file')
    expect(row).toMatchObject({
      status: 'completed',
      patchSummary: { files: 1, added: 1, removed: 1 },
      thenRun: { command: 'npm test -- a', outcome: 'failed', output: '1 failing', exitCode: 1 },
    })
    expect(t.io.files.get(`${ROOT}/src/a.ts`)).toBe('const a = 2\n')
  })

  it('asks for the command where a shell command asks, after the edit’s own card', async () => {
    const t = setup({ isDiagnosticsOn: false })
    const { cards, turn } = await start(t, 'promptUnmatched')
    t.api.script({ calls: [editCall('1', '2', 'npm test')] }, { text: 'ok' })
    await turn()
    expect(cards.map((card) => [card.itemId, card.subject])).toEqual([
      [cards[0]?.itemId, { kind: 'fileWrite', path: 'src/a.ts', toolName: 'edit_file' }],
      [cards[0]?.itemId, { kind: 'shell', command: 'npm test' }],
    ])
  })

  it('does not run a rejected command, or in Restricted Mode, or in Plan', async () => {
    const rejected = setup({ isDiagnosticsOn: false })
    const first = await start(rejected, 'onRequest', () => 'abort')
    rejected.api.script({ calls: [editCall('1', '2', 'npm test')] }, { text: 'ok' })
    await first.turn()
    expect(rejected.io.shellCalls).toEqual([])
    expect(completedRows(first.events, 'edit_file')[0]?.thenRun).toEqual({
      command: 'npm test',
      outcome: 'notRun',
      skip: 'rejected',
      output: '',
    })
    expect(outputs(rejected.api.responseBodies()[1])[0]).toContain(
      fill(MODEL_TEXT.thenRunNotRun, { reason: MODEL_TEXT.checkSkipRejected }),
    )

    const restricted = setup({ isDiagnosticsOn: false, isTrusted: false })
    const second = await start(restricted, 'allowAll')
    restricted.api.script({ calls: [editCall('1', '2', 'npm test')] }, { text: 'ok' })
    await second.turn()
    expect(restricted.io.shellCalls).toEqual([])
    expect(completedRows(second.events, 'edit_file')[0]?.thenRun?.skip).toBe('restricted')
    // Restricted Mode offers no then_run at all.
    expect(JSON.stringify(restricted.api.responseBodies()[0]?.['tools'])).not.toContain('then_run')

    const plan = setup({ isDiagnosticsOn: false })
    const third = await start(plan, 'denyUnmatched')
    plan.api.script({ calls: [editCall('1', '2', 'npm test')] }, { text: 'ok' })
    await third.turn()
    expect(plan.io.shellCalls).toEqual([])
    expect(plan.io.files.get(`${ROOT}/src/a.ts`)).toBe('const a = 1\n')
    expect(completedRows(third.events, 'edit_file')[0]?.thenRun).toBeUndefined()
  })

  it('skips the command when the file changed after the edit (the guard)', async () => {
    const t = setup({ isDiagnosticsOn: false })
    // The file changes while the command's card is open.
    const { turn } = await start(t, 'onRequest', () => {
      t.io.files.set(`${ROOT}/src/a.ts`, 'someone else wrote this\n')
      return 'allow_once'
    })
    t.api.script({ calls: [editCall('1', '2', 'npm test')] }, { text: 'ok' })
    await turn()
    expect(t.io.shellCalls).toEqual([])
    expect(outputs(t.api.responseBodies()[1])[0]).toContain(
      fill(MODEL_TEXT.thenRunNotRun, { reason: MODEL_TEXT.checkSkipChanged }),
    )
  })

  it('takes the guard’s hash after format on edit, so a formatted file still runs', async () => {
    const t = setup({
      isDiagnosticsOn: false,
      isFormatOnEdit: true,
      format: (_path, text) => Promise.resolve(text.replace('=', ' =  ')),
    })
    const { events, turn } = await start(t, 'allowAll')
    t.api.script({ calls: [editCall('a = 1', 'a=2', 'npm test')] }, { text: 'ok' })
    await turn()
    expect(t.io.files.get(`${ROOT}/src/a.ts`)).toBe('const a =  2\n')
    expect(t.io.shellCalls.map((call) => call.command)).toEqual(['npm test'])
    const [output] = outputs(t.api.responseBodies()[1])
    expect(output).toContain(`edited src/a.ts. ${MODEL_TEXT.formattedAfterEdit}`)
    // The row's diff is the formatted result.
    expect(completedRows(events, 'edit_file')[0]?.visibleOutput).toContain('+const a =  2')
    expect(t.formatCalls).toEqual([`${ROOT}/src/a.ts`])
  })

  it('keeps the edit and its diff when the turn is stopped at the command’s card', async () => {
    const t = setup({ isDiagnosticsOn: false })
    const started = await start(t, 'onRequest', () => 'hold')
    await stopAtFirstCard(started, t, editCall('1', '2', 'npm test'))
    const [row] = completedRows(started.events, 'edit_file')
    expect(row).toMatchObject({
      status: 'completed',
      patchSummary: { files: 1 },
      thenRun: { command: 'npm test', outcome: 'cancelled' },
    })
  })

  it('says the command did not run when the edit itself failed', async () => {
    const t = setup({ isDiagnosticsOn: false })
    const { turn } = await start(t, 'allowAll')
    t.api.script({ calls: [editCall('not there', 'x', 'npm test')] }, { text: 'ok' })
    await turn()
    expect(t.io.shellCalls).toEqual([])
    expect(outputs(t.api.responseBodies()[1])[0]).toBe(
      `Error: find text not found in src/a.ts\n${MODEL_TEXT.thenRunEditFailed}`,
    )
  })
})

describe('format on edit', () => {
  it('writes the formatter’s text before the checks, and is off unless turned on', async () => {
    const t = setup({
      files: {},
      isFormatOnEdit: true,
      format: (_path, text) => Promise.resolve(`${text.trimEnd()};\n`),
    })
    const { turn } = await start(t, 'allowAll')
    t.api.script({ calls: [writeCall('src/n.ts', 'export const n = 1')] }, { text: 'ok' })
    await turn()
    expect(t.io.files.get(`${ROOT}/src/n.ts`)).toBe('export const n = 1;\n')
    const off = setup({ files: {} })
    const second = await start(off, 'allowAll')
    off.api.script({ calls: [writeCall('src/n.ts', 'export const n = 1')] }, { text: 'ok' })
    await second.turn()
    expect(off.formatCalls).toEqual([])
    expect(off.io.files.get(`${ROOT}/src/n.ts`)).toBe('export const n = 1')
  })

  it('leaves the edit as written when the formatter fails, and logs it', async () => {
    const t = setup({
      isFormatOnEdit: true,
      format: () => Promise.reject(new Error('formatter crashed')),
    })
    const { events, turn } = await start(t, 'allowAll')
    t.api.script({ calls: [editCall('1', '2')] }, { text: 'ok' })
    await turn()
    expect(t.io.files.get(`${ROOT}/src/a.ts`)).toBe('const a = 2\n')
    expect(completedRows(events, 'edit_file')[0]?.status).toBe('completed')
    expect(logLines(t.log).join('\n')).toContain(
      'Format on edit failed; the edit stays as written: formatter crashed',
    )
  })
})

describe('the instructions', () => {
  it('describe the loop, the checks, run_checks and then_run as they are offered', async () => {
    const t = setup({ checks: [LINT] })
    const { turn } = await start(t, 'allowAll')
    t.api.script({ text: 'ok' })
    await turn()
    const instructions = String(t.api.responseBodies()[0]?.['instructions'])
    expect(instructions).toContain('# Checking your work')
    expect(instructions).toContain("errors and warnings from VS Code's language servers")
    expect(instructions).toContain('lint (`npm run lint`)')
    expect(instructions).toContain('run_checks')
    expect(instructions).toContain('then_run')
    const restricted = setup({ checks: [LINT], isTrusted: false, isDiagnosticsOn: false })
    const second = await start(restricted, 'allowAll')
    restricted.api.script({ text: 'ok' })
    await second.turn()
    expect(String(restricted.api.responseBodies()[0]?.['instructions'])).not.toContain(
      '# Checking your work',
    )
  })
})
