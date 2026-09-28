// The code intelligence tools on the Model API backend (M67, PLAN.md D49),
// through the host on the fake Model API: reads that run in every mode
// (Restricted Mode included), a rename that asks and writes like an edit
// (protected paths, Plan, a file changed while the card was open), and the
// opt-in repo map in the system prompt.

import { describe, expect, it, vi } from 'vitest'
import { ModelApiHost } from '../../src/core/backends/modelapi/ModelApiHost'
import type { AgentEvent } from '../../src/shared/agentEvents'
import { MODEL_TEXT } from '../../src/shared/constants'
import { memoryContextIo } from './helpers/fakeContextIo'
import {
  type FakeServiceOptions,
  fakeLanguageService,
  KIND,
  loc,
  sym,
} from './helpers/fakeLanguageService'
import { FakeLogOutputChannel } from './helpers/fakes'
import {
  FAKE_MODEL_API_ACCOUNT_ID,
  fakeModelApi,
  fakeModelApiClient,
  type ScriptedCall,
} from './helpers/fakeModelApi'
import { disabledPaidFeatures } from './helpers/fakePaidFeatures'
import { memoryToolIo } from './helpers/fakeToolIo'

const ROOT = '/ws'
const A = `${ROOT}/src/a.ts`
const B = `${ROOT}/src/b.ts`
const TASKS = `${ROOT}/.vscode/tasks.ts`
const FILES = {
  'src/a.ts': 'export function greet() {}\n',
  'src/b.ts': "import { greet } from './a'\ngreet()\n",
  '.vscode/tasks.ts': 'greet()\n',
}
const TOOLS = [
  'find_definition',
  'find_references',
  'workspace_symbols',
  'document_symbols',
  'hover',
  'call_hierarchy',
  'repo_map',
  'rename_symbol',
]
const RENAME: ScriptedCall = {
  name: 'rename_symbol',
  arguments: JSON.stringify({ path: 'src/a.ts', symbol: 'greet', new_name: 'welcome' }),
}

function renamed(path: string, line: number, character: number) {
  return {
    path,
    edits: [
      {
        range: { start: { line, character }, end: { line, character: character + 5 } },
        newText: 'welcome',
      },
    ],
  }
}

interface StartOptions {
  readonly approvalMode?: string
  readonly isTrusted?: boolean
  /** The language services' answers; null runs the host without them. */
  readonly service?: Omit<FakeServiceOptions, 'files'> | null
  readonly isRepoMapOn?: () => boolean
}

async function start(options: StartOptions = {}) {
  const api = fakeModelApi()
  const io = memoryToolIo(FILES, ROOT)
  const service =
    options.service === null
      ? undefined
      : fakeLanguageService({ files: io.files, ...options.service })
  let ids = 0
  const log = new FakeLogOutputChannel()
  // Built directly on POSIX paths: the manager would take this machine's platform.
  const host = new ModelApiHost({
    ...disabledPaidFeatures,
    client: fakeModelApiClient(api, log),
    log,
    workspaceRoot: ROOT,
    platform: 'linux',
    io,
    contextIo: memoryContextIo(io.files),
    newId: () => {
      ids += 1
      return `n${String(ids)}`
    },
    now: () => 0,
    personalSkillsRoot: undefined,
    isWorkspaceTrusted: () => options.isTrusted ?? true,
    describeEnvironment: () => Promise.resolve({ git: undefined }),
    promptCacheRetention: () => 'in_memory',
    getAccountId: () => Promise.resolve(FAKE_MODEL_API_ACCOUNT_ID),
    memory: undefined,
    codeIntel: service,
    isRepoMapInPrompt: options.isRepoMapOn,
  })
  const session = await host.startSession({
    workspaceRoot: ROOT,
    modelId: 'muse-spark-1.3',
    approvalMode: options.approvalMode ?? 'promptUnmatched',
  })
  const events: AgentEvent[] = []
  session.onEvent((event) => {
    events.push(event)
  })
  let turns = 0
  /** Sends a message whose reply makes these calls and then answers; waits for the turn's end. */
  const turn = async (calls: readonly ScriptedCall[], isCardExpected = false) => {
    turns += 1
    const expected = turns
    api.script({ calls }, { text: 'done' })
    await session.sendTurn([{ type: 'text', text: 'go' }])
    if (!isCardExpected) {
      await vi.waitFor(() => {
        expect(events.filter((event) => event.type === 'turnCompleted')).toHaveLength(expected)
      })
    }
  }
  return { api, io, service, session, events, turn }
}

type Started = Awaited<ReturnType<typeof start>>

/** The tool rows' final states, in order. */
function finished(events: readonly AgentEvent[]) {
  return events.flatMap((event) =>
    event.type === 'itemCompleted' && event.item.kind === 'toolCall' ? [event.item] : [],
  )
}

/** What the model was given back for its calls in the request after them. */
function outputs(api: ReturnType<typeof fakeModelApi>): readonly string[] {
  const input = api.responseBodies().at(-1)?.['input']
  return (Array.isArray(input) ? input : []).flatMap((item: unknown) =>
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'function_call_output' &&
    'output' in item &&
    typeof item.output === 'string'
      ? [item.output]
      : [],
  )
}

async function cardFor(events: readonly AgentEvent[]) {
  await vi.waitFor(() => {
    expect(events.some((event) => event.type === 'approvalRequested')).toBe(true)
  })
  const card = events.find((event) => event.type === 'approvalRequested')
  if (card?.type !== 'approvalRequested') {
    throw new Error('no card')
  }
  return card
}

/** Allows the card once, as the user would, and waits for the turn to end. */
async function allowAndFinish(t: Started, card: Awaited<ReturnType<typeof cardFor>>) {
  await t.session.decideApproval({
    approvalId: card.approvalId,
    choiceId: 'allow_once',
    requirementId: card.requirementId,
  })
  await vi.waitFor(() => {
    expect(t.events.some((event) => event.type === 'turnCompleted')).toBe(true)
  })
}

const GREET_EVERYWHERE = {
  rename: () =>
    Promise.resolve({
      files: [renamed(A, 0, 16), renamed(B, 0, 9), renamed(B, 1, 0)],
      hasFileOperations: false,
    }),
}

describe('code intelligence on the Model API backend', () => {
  it('offers the tools with their guidance only while language services are there', async () => {
    const t = await start()
    await t.turn([])
    const body = t.api.responseBodies()[0] ?? {}
    const names = (body['tools'] as { name?: string }[]).map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(TOOLS))
    expect(String(body['instructions'])).toContain(MODEL_TEXT.codeIntelInstructions)
    const without = await start({ service: null })
    await without.turn([])
    const plain = without.api.responseBodies()[0] ?? {}
    expect((plain['tools'] as { name?: string }[]).map((tool) => tool.name)).not.toContain('hover')
    expect(String(plain['instructions'])).not.toContain(MODEL_TEXT.codeIntelInstructions)
  })

  it('reads without a card in Plan and in Restricted Mode, and says when no service answers', async () => {
    const t = await start({
      approvalMode: 'denyUnmatched',
      isTrusted: false,
      service: { references: () => [loc(A, 0, 16), loc(B, 1, 0)] },
    })
    await t.turn([
      { name: 'find_references', arguments: '{"path":"src/b.ts","line":2,"column":1}' },
      { name: 'find_definition', arguments: '{"path":"src/a.ts","line":1,"column":1}' },
      { name: 'hover', arguments: 'not json' },
    ])
    expect(t.events.some((event) => event.type === 'approvalRequested')).toBe(false)
    const [references, definition, hover] = outputs(t.api)
    expect(references).toBe('src/a.ts:1:17: export function greet() {}\nsrc/b.ts:2:1: greet()')
    expect(definition).toContain('Error: no language service answered for src/a.ts')
    expect(hover).toBe('Error: arguments are not valid JSON')
    expect(finished(t.events).map((item) => item.status)).toEqual(['completed', 'failed', 'failed'])
    expect(finished(t.events)[1]?.failureReason).toBe('No language service answered for src/a.ts.')
  })

  it('renames through the edit path: a card naming the files, then one patch across them', async () => {
    const t = await start({ service: GREET_EVERYWHERE })
    await t.turn([RENAME], true)
    const card = await cardFor(t.events)
    expect(card.subject).toEqual({
      kind: 'fileWrite',
      path: 'src/a.ts, src/b.ts',
      toolName: 'rename_symbol',
    })
    expect(card.isProtectedWrite).toBe(false)
    await allowAndFinish(t, card)
    expect(t.io.files.get(A)).toBe('export function welcome() {}\n')
    expect(t.io.files.get(B)).toBe("import { welcome } from './a'\nwelcome()\n")
    expect(finished(t.events)[0]).toMatchObject({
      status: 'completed',
      patchSummary: { files: 2, added: 3, removed: 3 },
    })
    expect(outputs(t.api)[0]).toContain('Renamed `greet` to `welcome`: 3 edits in 2 files')
  })

  it('writes without a card in Auto, and write_file may then replace a renamed file', async () => {
    const t = await start({ approvalMode: 'onRequest', service: GREET_EVERYWHERE })
    await t.turn([
      RENAME,
      { name: 'write_file', arguments: JSON.stringify({ path: 'src/b.ts', content: 'gone\n' }) },
    ])
    expect(t.events.some((event) => event.type === 'approvalRequested')).toBe(false)
    expect(t.io.files.get(A)).toBe('export function welcome() {}\n')
    expect(t.io.files.get(B)).toBe('gone\n')
  })

  it('asks for a protected file in every mode but Bypass, and Plan refuses a rename', async () => {
    const protectedRename = {
      rename: () =>
        Promise.resolve({
          files: [renamed(A, 0, 16), renamed(TASKS, 0, 0)],
          hasFileOperations: false,
        }),
    }
    const auto = await start({ approvalMode: 'onRequest', service: protectedRename })
    await auto.turn([RENAME], true)
    expect(await cardFor(auto.events)).toMatchObject({ isProtectedWrite: true })
    const plan = await start({ approvalMode: 'denyUnmatched', service: GREET_EVERYWHERE })
    await plan.turn([RENAME])
    expect(outputs(plan.api)[0]).toBe(`Error: rename_symbol ${MODEL_TEXT.toolRefusedByMode}`)
    expect(plan.io.files.get(A)).toBe(FILES['src/a.ts'])
    // Refused before the language service is asked for anything.
    expect(plan.service?.asked.some((call) => call.startsWith('rename'))).toBe(false)
  })

  it.each([
    [
      'changed',
      (t: Started) => {
        t.io.files.set(B, 'someone else wrote this\n')
      },
      'src/b.ts changed while the rename waited for approval',
    ],
    [
      'gained unsaved changes',
      (t: Started) => {
        t.io.unsaved.add(B)
      },
      `src/b.ts ${MODEL_TEXT.fileHasUnsavedChanges}`,
    ],
    [
      'became a link elsewhere',
      (t: Started) => {
        t.io.realPath = (path) => Promise.resolve(path === B ? `${ROOT}/src/elsewhere.ts` : path)
      },
      MODEL_TEXT.pathChangedAfterApproval,
    ],
  ])('writes nothing when a file %s while the card was open', async (_what, change, reason) => {
    const t = await start({ service: GREET_EVERYWHERE })
    await t.turn([RENAME], true)
    const card = await cardFor(t.events)
    change(t)
    await allowAndFinish(t, card)
    expect(outputs(t.api)[0]).toMatch(/^Error: /)
    expect(outputs(t.api)[0]).toContain(reason)
    expect(t.io.files.get(A)).toBe(FILES['src/a.ts'])
  })

  it('says which files a failed write left renamed, and the row can revert them', async () => {
    const t = await start({ approvalMode: 'onRequest', service: GREET_EVERYWHERE })
    const write = t.io.writeFile
    t.io.writeFile = (path, content, expected) =>
      path === B ? Promise.reject(new Error('disk full')) : write(path, content, expected)
    await t.turn([RENAME])
    expect(outputs(t.api)[0]).toBe(
      'Error: writing src/b.ts failed: disk full. The rename was written to 1 of 2 files (src/a.ts); the rest are unchanged, and the row can revert what was written',
    )
    expect(finished(t.events)[0]).toMatchObject({
      status: 'failed',
      patchSummary: { files: 1, added: 1, removed: 1 },
    })
  })

  it('refuses a rename it cannot plan before any card, and Stop ends a call that hangs', async () => {
    const t = await start({ service: { definitions: () => new Promise(() => undefined) } })
    await t.turn([RENAME])
    expect(t.events.some((event) => event.type === 'approvalRequested')).toBe(false)
    expect(outputs(t.api)[0]).toContain('no language service answered for src/a.ts')
    t.api.script({
      calls: [{ name: 'find_definition', arguments: '{"symbol":"greet","path":"src/b.ts"}' }],
    })
    await t.session.sendTurn([{ type: 'text', text: 'hang' }])
    await vi.waitFor(() => {
      expect(t.service?.asked.some((call) => call.startsWith('definitions'))).toBe(true)
    })
    await t.session.cancel()
    await vi.waitFor(() => {
      expect(t.events.filter((event) => event.type === 'turnCompleted')).toHaveLength(2)
    })
    expect(t.events.findLast((event) => event.type === 'turnCompleted')).toMatchObject({
      terminal: 'cancelled',
    })
  })

  it('pins the repo map in the prompt once per session while the setting is on', async () => {
    let isOn = true
    const t = await start({
      isRepoMapOn: () => isOn,
      service: {
        workspace: (query) =>
          Promise.resolve(query === 'greet' ? [sym('greet', KIND.function, A, 0, 16)] : []),
      },
    })
    await t.turn([])
    await t.turn([])
    const [first, second] = t.api.responseBodies().map((body) => String(body['instructions']))
    expect(first).toContain('# Repo map')
    expect(first).toContain('src/a.ts\n  1: function greet')
    expect(second).toBe(first)
    expect(t.service?.asked.filter((call) => call === 'workspace greet')).toHaveLength(1)
    isOn = false
    await t.turn([])
    expect(String(t.api.responseBodies().at(-1)?.['instructions'])).not.toContain('# Repo map')
    // A Stop while the map is being made ends the turn at once; the next makes it again.
    let isStuck = true
    const stopped = await start({
      isRepoMapOn: () => true,
      service: {
        workspace: (query) =>
          isStuck
            ? new Promise(() => undefined)
            : Promise.resolve(query === 'greet' ? [sym('greet', KIND.function, A, 0, 16)] : []),
      },
    })
    await stopped.session.sendTurn([{ type: 'text', text: 'go' }])
    await vi.waitFor(() => {
      expect(stopped.service?.asked.some((call) => call.startsWith('workspace'))).toBe(true)
    })
    await stopped.session.cancel()
    await vi.waitFor(() => {
      expect(stopped.events.some((event) => event.type === 'turnCompleted')).toBe(true)
    })
    isStuck = false
    stopped.api.script({ text: 'done' })
    await stopped.session.sendTurn([{ type: 'text', text: 'again' }])
    await vi.waitFor(() => {
      expect(stopped.events.filter((event) => event.type === 'turnCompleted')).toHaveLength(2)
    })
    expect(stopped.events.find((event) => event.type === 'turnCompleted')).toMatchObject({
      terminal: 'cancelled',
    })
    expect(String(stopped.api.responseBodies().at(-1)?.['instructions'])).toContain('# Repo map')
    const quiet = await start({
      isRepoMapOn: () => true,
      service: { workspace: () => Promise.resolve([]) },
    })
    await quiet.turn([])
    expect(String(quiet.api.responseBodies()[0]?.['instructions'])).not.toContain('# Repo map')
  })
})
