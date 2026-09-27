import { mkdtempSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createFileScheduleStore } from '../../src/host/backend/fileScheduleStore'
import { MILLISECONDS_PER_DAY } from '../../src/shared/constants'
import type { ScheduledPrompt } from '../../src/shared/schedule'
import { FakeLogOutputChannel } from './helpers/fakes'
import { removeFolder } from './helpers/temporaryFolders'

const root = mkdtempSync(path.join(tmpdir(), 'muse-schedules-'))
afterAll(() => removeFolder(root))

const START = Date.parse('2026-09-25T09:00:00.000Z')
const MINUTE = 60 * 1000

function job(id: string, overrides: Partial<ScheduledPrompt> = {}): ScheduledPrompt {
  return {
    id,
    sessionId: 'session-1',
    workspaceRoot: '/workspace',
    accountId: 'key-digest-1',
    prompt: 'Review the build',
    cadence: { kind: 'interval', everyMs: MINUTE },
    createdAtMs: START,
    expiresAtMs: START + 7 * MILLISECONDS_PER_DAY,
    nextFireAtMs: START + MINUTE,
    fireCount: 0,
    ...overrides,
  }
}

describe('workspace schedule store (M52)', () => {
  it('isolates jobs by session and persists them across store instances', async () => {
    const directory = path.join(root, 'session-scope')
    const first = createFileScheduleStore({
      directory,
      now: () => START,
      log: new FakeLogOutputChannel(),
    })
    await first.create(job('a'))
    await first.create(job('b', { sessionId: 'session-2' }))
    const reopened = createFileScheduleStore({
      directory,
      now: () => START,
      log: new FakeLogOutputChannel(),
    })
    const firstSession = await reopened.list('session-1')
    const secondSession = await reopened.list('session-2')
    expect(firstSession.map((entry) => entry.id)).toEqual(['a'])
    expect(secondSession.map((entry) => entry.id)).toEqual(['b'])
    await expect(first.create(job('a'))).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('admits one due occurrence across two windows, keeps a receipt after restart, and skips backlog', async () => {
    const directory = path.join(root, 'claim-race')
    let now = START + 3 * MINUTE
    const makeStore = () =>
      createFileScheduleStore({ directory, now: () => now, log: new FakeLogOutputChannel() })
    const left = makeStore()
    const right = makeStore()
    await left.create(job('race'))
    const [due] = await left.list('session-1')
    if (due === undefined) {
      throw new Error('expected due job')
    }
    const admitted = await Promise.all([
      left.claim(due, due.nextFireAtMs),
      right.claim(due, due.nextFireAtMs),
    ])
    expect(admitted.toSorted((a, b) => Number(a) - Number(b))).toEqual([false, true])
    const reopened = makeStore()
    const [next] = await reopened.list('session-1')
    expect(next?.fireCount).toBe(1)
    expect(next?.lastFireAtMs).toBe(START + MINUTE)
    expect(next?.nextFireAtMs).toBe(now + MINUTE)
    expect(await reopened.claim(due, due.nextFireAtMs)).toBe(false)
    now += MINUTE
    const [second] = await reopened.list('session-1')
    if (second === undefined) {
      throw new Error('expected second fire')
    }
    expect(await reopened.claim(second, second.nextFireAtMs)).toBe(true)
    const afterSecond = await reopened.list('session-1')
    expect(afterSecond[0]?.fireCount).toBe(2)
  })

  it('refuses early and cancelled fires without a receipt', async () => {
    const directory = path.join(root, 'cancel')
    const store = createFileScheduleStore({
      directory,
      now: () => START,
      log: new FakeLogOutputChannel(),
    })
    const scheduled = job('cancel-me')
    await store.create(scheduled)
    expect(await store.claim(scheduled, scheduled.nextFireAtMs)).toBe(false)
    expect(await store.remove('another-session', scheduled.id)).toBe(false)
    expect(await store.remove(scheduled.sessionId, scheduled.id)).toBe(true)
    expect(await store.claim(scheduled, scheduled.nextFireAtMs)).toBe(false)
    expect(await readdir(directory)).toEqual([])
  })

  it('refuses a prompt changed between the due list and atomic admission', async () => {
    const directory = path.join(root, 'prompt-change')
    const store = createFileScheduleStore({
      directory,
      now: () => START + MINUTE,
      log: new FakeLogOutputChannel(),
    })
    await store.create(job('prompt-change'))
    const [due] = await store.list('session-1')
    if (due === undefined) {
      throw new Error('expected due job')
    }
    await writeFile(
      path.join(directory, 'prompt-change.json'),
      JSON.stringify({
        ...due,
        prompt: 'A different prompt',
      }),
    )
    expect(await store.claim(due, due.nextFireAtMs)).toBe(false)
    const names = await readdir(directory)
    expect(names.some((name) => name.endsWith('.claim'))).toBe(false)
  })

  it('skips corrupt files and deletes expired jobs from any session', async () => {
    const directory = path.join(root, 'expiry')
    const log = new FakeLogOutputChannel()
    const store = createFileScheduleStore({
      directory,
      now: () => START + 8 * MILLISECONDS_PER_DAY,
      log,
    })
    await store.create(job('expired'))
    await writeFile(path.join(directory, 'corrupt.json'), '{')
    expect(await store.list('different-session')).toEqual([])
    expect(await readdir(directory)).toEqual(['corrupt.json'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('corrupt skipped'))
  })

  it('removes an old stored seven-day job whose first fire is expiry', async () => {
    const directory = path.join(root, 'equal-expiry')
    const store = createFileScheduleStore({
      directory,
      now: () => START + MINUTE,
      log: new FakeLogOutputChannel(),
    })
    await store.create(
      job('equal-expiry', {
        cadence: { kind: 'interval', everyMs: 7 * MILLISECONDS_PER_DAY },
        nextFireAtMs: START + 7 * MILLISECONDS_PER_DAY,
      }),
    )
    expect(await store.list('session-1')).toEqual([])
    expect(await readdir(directory)).toEqual([])
  })

  it('admits a final due fire before expiry and refuses a late claim at expiry', async () => {
    const directory = path.join(root, 'expiry-boundary')
    const expiry = START + 7 * MILLISECONDS_PER_DAY
    let now = expiry - 1
    const store = createFileScheduleStore({
      directory,
      now: () => now,
      log: new FakeLogOutputChannel(),
    })
    const due = job('final-due', { nextFireAtMs: expiry - MINUTE })
    const late = job('too-late', { nextFireAtMs: expiry - MINUTE })
    await store.create(due)
    await store.create(late)
    expect(await store.list('session-1')).toHaveLength(2)
    expect(await store.claim(due, due.nextFireAtMs)).toBe(true)
    expect(await store.claim(due, due.nextFireAtMs)).toBe(false)
    now = expiry
    expect(await store.claim(late, late.nextFireAtMs)).toBe(false)
    expect(await store.list('session-1')).toEqual([])
    const names = await readdir(directory)
    expect(names).toEqual([`${due.id}.${String(due.nextFireAtMs)}.claim`])
  })

  it('refuses a claim whose receipt write crosses the expiry boundary', async () => {
    const directory = path.join(root, 'expiry-during-claim')
    const expiry = START + 7 * MILLISECONDS_PER_DAY
    let reads = 0
    const store = createFileScheduleStore({
      directory,
      now: () => {
        reads += 1
        return reads < 4 ? expiry - 1 : expiry
      },
      log: new FakeLogOutputChannel(),
    })
    const due = job('crossing', { nextFireAtMs: expiry - MINUTE })
    await store.create(due)
    expect(await store.claim(due, due.nextFireAtMs)).toBe(false)
    expect(await readdir(directory)).toContain(`${due.id}.${String(due.nextFireAtMs)}.claim`)
    expect(await store.list(due.sessionId)).toEqual([])
  })
})
