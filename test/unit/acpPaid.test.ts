import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AcpPaidUse, paidUseAnswer, paidUseOptions } from '../../src/acp/paid'
import { paidGrantFile } from '../../src/runtime/paidGrants'
import { workspaceKey } from '../../src/runtime/dataFolder'
import { memoryPaidGrants } from './helpers/paidGrants'
import { removeFolder } from './helpers/temporaryFolders'

// M58 in the agent (PLAN.md D48, D62): a paid use is off without its flag,
// asks the editor each time otherwise, and "Allow always" is kept per folder
// in the agent's data folder and forgotten when the agent starts without the
// flag.

const FOLDER = path.resolve('work', 'app')
const OTHER = path.resolve('work', 'other')
const WEB_SEARCH = { feature: 'webSearch' } as const
const folders: string[] = []

afterAll(async () => {
  await Promise.all(folders.map((folder) => removeFolder(folder)))
})

function logger() {
  return { trace: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function grantsFile(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'acp-paid-grants-'))
  folders.push(folder)
  return path.join(folder, 'acp', 'paid-uses.json')
}

/** The client chose the option of that id. */
function selected(optionId: string) {
  return { outcome: { outcome: 'selected' as const, optionId } }
}

function fileStore(file: string, log = logger()) {
  return paidGrantFile({ file, log, sleep: () => Promise.resolve() })
}

describe('AcpPaidUse', () => {
  it('denies every use until the agent attaches its way to ask', async () => {
    const log = logger()
    const paid = new AcpPaidUse({
      flagged: ['webSearch'],
      canRemember: () => true,
      grants: memoryPaidGrants(),
      log,
    })
    expect(await paid.allows(FOLDER, 's1', WEB_SEARCH, false)).toBe(false)
    expect(log.warn).toHaveBeenCalledWith(
      'Paid use of webSearch: no editor to ask, so it is denied',
    )
    const asker = vi.fn(() => Promise.reject(new Error('the connection closed')))
    paid.attach(asker)
    expect(await paid.allows(FOLDER, 's1', WEB_SEARCH, false)).toBe(false)
    expect(asker).toHaveBeenCalledWith('s1', WEB_SEARCH, true)
    expect(log.warn).toHaveBeenCalledWith(
      'Paid use of webSearch: the editor could not be asked, so it is denied: Error',
    )
  })

  it('keeps "always" per folder, asks again where a hook demands it, and not without trust', async () => {
    const grants = memoryPaidGrants()
    let isTrusted = true
    const paid = new AcpPaidUse({
      flagged: ['webSearch'],
      canRemember: () => isTrusted,
      grants,
      log: logger(),
    })
    const asker = vi.fn(() => Promise.resolve('always' as const))
    paid.attach(asker)
    expect(await paid.allows(FOLDER, 's1', WEB_SEARCH, false)).toBe(true)
    expect(await paid.allows(FOLDER, 's1', WEB_SEARCH, false)).toBe(true)
    expect(asker).toHaveBeenCalledTimes(1)
    expect(await paid.allows(FOLDER, 's1', WEB_SEARCH, true)).toBe(true)
    expect(await paid.allows(OTHER, 's2', WEB_SEARCH, false)).toBe(true)
    expect(asker).toHaveBeenCalledTimes(3)
    expect(asker).toHaveBeenLastCalledWith('s2', WEB_SEARCH, true)
    isTrusted = false
    expect(paid.isRemembered(FOLDER, 'webSearch')).toBe(false)
    expect(await paid.allows(FOLDER, 's1', WEB_SEARCH, false)).toBe(true)
    expect(asker).toHaveBeenLastCalledWith('s1', WEB_SEARCH, false)
  })

  it('forgets "always" for every feature it starts without', async () => {
    const grants = memoryPaidGrants()
    grants.byFolder.set(FOLDER, new Set(['webSearch', 'imageGeneration']))
    const paid = new AcpPaidUse({
      flagged: ['imageGeneration'],
      canRemember: () => true,
      grants,
      log: logger(),
    })
    expect(paid.isRemembered(FOLDER, 'webSearch')).toBe(false)
    await paid.forgetUnflagged()
    expect(grants.byFolder.get(FOLDER)).toEqual(new Set(['imageGeneration']))
    expect(paid.isRemembered(FOLDER, 'imageGeneration')).toBe(true)
  })

  it('logs a grants file it cannot write, and still honours nothing unflagged', async () => {
    const grants = memoryPaidGrants()
    grants.byFolder.set(FOLDER, new Set(['webSearch']))
    vi.spyOn(grants, 'forget').mockRejectedValue(new Error('read-only data folder'))
    const log = logger()
    const paid = new AcpPaidUse({ flagged: [], canRemember: () => true, grants, log })
    await paid.forgetUnflagged()
    expect(log.warn).toHaveBeenCalledWith(
      'Paid uses allowed always could not be forgotten for webSearch, imageGeneration: read-only data folder',
    )
    expect(paid.isRemembered(FOLDER, 'webSearch')).toBe(false)
  })

  it('lets an "always" it cannot keep go ahead once, and asks again next time', async () => {
    const grants = memoryPaidGrants()
    vi.spyOn(grants, 'add').mockRejectedValue(new Error('read-only data folder'))
    const log = logger()
    const paid = new AcpPaidUse({ flagged: ['webSearch'], canRemember: () => true, grants, log })
    const asker = vi.fn(() => Promise.resolve('always' as const))
    paid.attach(asker)
    expect(await paid.allows(FOLDER, 's1', WEB_SEARCH, false)).toBe(true)
    expect(log.warn).toHaveBeenCalledWith(
      'Paid use of webSearch: "always" could not be kept, so it is allowed once: read-only data folder',
    )
    expect(log.info).toHaveBeenLastCalledWith('Paid use of webSearch: allowed once')
    expect(await paid.allows(FOLDER, 's1', WEB_SEARCH, false)).toBe(true)
    expect(asker).toHaveBeenCalledTimes(2)
  })

  it('leaves the grants alone when every feature is flagged', async () => {
    const grants = memoryPaidGrants()
    const forget = vi.spyOn(grants, 'forget')
    const paid = new AcpPaidUse({
      flagged: ['webSearch', 'imageGeneration'],
      canRemember: () => true,
      grants,
      log: logger(),
    })
    await paid.forgetUnflagged()
    expect(forget).not.toHaveBeenCalled()
  })

  it('tallies billed uses in the log', () => {
    const log = logger()
    const paid = new AcpPaidUse({
      flagged: ['imageGeneration'],
      canRemember: () => false,
      grants: memoryPaidGrants(),
      log,
    })
    paid.noteUse('imageGeneration', 1)
    paid.noteUse('imageGeneration', 2)
    expect(log.info).toHaveBeenLastCalledWith(
      'Paid use of imageGeneration: 2, 3 since the agent started',
    )
  })
})

describe('the paid-use prompt’s options and answers', () => {
  it('offers "always" only where it is kept', () => {
    expect(paidUseOptions(true).map((option) => option.optionId)).toEqual([
      'paid-allow-once',
      'paid-allow-always',
      'paid-deny',
    ])
    expect(paidUseOptions(false).map((option) => option.optionId)).toEqual([
      'paid-allow-once',
      'paid-deny',
    ])
  })

  it('reads anything but a chosen allow as Deny', () => {
    expect(paidUseAnswer(selected('paid-allow-once'), false)).toBe('once')
    expect(paidUseAnswer(selected('paid-allow-always'), true)).toBe('always')
    expect(paidUseAnswer(selected('paid-allow-always'), false)).toBe('deny')
    expect(paidUseAnswer(selected('paid-deny'), true)).toBe('deny')
    expect(paidUseAnswer({ outcome: { outcome: 'cancelled' } }, true)).toBe('deny')
  })
})

describe('the grants file (runtime/paidGrants.ts)', () => {
  it('reads nothing before the first grant, then each folder’s own, from any process', async () => {
    const file = grantsFile()
    const store = fileStore(file)
    expect(store.read(FOLDER)).toEqual(new Set())
    await store.add(FOLDER, ['webSearch'])
    await store.add(OTHER, ['imageGeneration'])
    // Another process's store over the same file sees them at once.
    const other = fileStore(file)
    expect(other.read(FOLDER)).toEqual(new Set(['webSearch']))
    expect(other.read(OTHER)).toEqual(new Set(['imageGeneration']))
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
    // Folder keys, never paths.
    expect(saved).toEqual({
      [workspaceKey(FOLDER)]: ['webSearch'],
      [workspaceKey(OTHER)]: ['imageGeneration'],
    })
    expect(JSON.stringify(saved)).not.toContain('work')
  })

  it('adds to the file as it is when written, never a set read before another change', async () => {
    const file = grantsFile()
    const store = fileStore(file)
    const other = fileStore(file)
    // Two sessions of one agent, each answering "always" for a different feature.
    await Promise.all([store.add(FOLDER, ['webSearch']), store.add(FOLDER, ['imageGeneration'])])
    expect(store.read(FOLDER)).toEqual(new Set(['webSearch', 'imageGeneration']))
    // A feature another agent forgot is not written back by a later add.
    await other.forget(['webSearch'])
    await store.add(FOLDER, ['imageGeneration'])
    expect(store.read(FOLDER)).toEqual(new Set(['imageGeneration']))
  })

  it('fails a change on a file it cannot read, rather than writing over it, and reads it as none', async () => {
    const file = grantsFile()
    const log = logger()
    const store = fileStore(file, log)
    // A folder where the file should be: there, and unreadable as a file.
    mkdirSync(file, { recursive: true })
    expect(store.read(FOLDER)).toEqual(new Set())
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Paid-use grants in'))
    await expect(store.add(FOLDER, ['webSearch'])).rejects.toThrow('could not be read')
    await expect(store.forget(['webSearch'])).rejects.toThrow('could not be read')
  })

  it('writes one change at a time, each on the file as it then is', async () => {
    const file = grantsFile()
    const store = fileStore(file)
    await Promise.all([store.add(FOLDER, ['webSearch']), store.add(OTHER, ['webSearch'])])
    expect(store.read(FOLDER)).toEqual(new Set(['webSearch']))
    expect(store.read(OTHER)).toEqual(new Set(['webSearch']))
  })

  it('forgets features in every folder, drops emptied folders, and writes nothing when none had them', async () => {
    const file = grantsFile()
    const store = fileStore(file)
    await store.add(FOLDER, ['webSearch', 'imageGeneration'])
    await store.add(OTHER, ['webSearch'])
    await store.forget(['webSearch'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      [workspaceKey(FOLDER)]: ['imageGeneration'],
    })
    writeFileSync(file, '{"marker":["imageGeneration"]}')
    await store.forget(['webSearch'])
    expect(readFileSync(file, 'utf8')).toBe('{"marker":["imageGeneration"]}')
  })

  it('counts a damaged file, or names that are not paid features, as no grants', async () => {
    const file = grantsFile()
    const log = logger()
    const store = fileStore(file, log)
    await store.add(FOLDER, ['webSearch'])
    writeFileSync(file, JSON.stringify({ [workspaceKey(FOLDER)]: ['webSearch', 'everything'] }))
    expect(store.read(FOLDER)).toEqual(new Set(['webSearch']))
    writeFileSync(file, '{"half":')
    expect(store.read(FOLDER)).toEqual(new Set())
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Paid-use grants in'))
    writeFileSync(file, '["webSearch"]')
    expect(store.read(FOLDER)).toEqual(new Set())
    expect(log.warn).toHaveBeenLastCalledWith(
      `Paid-use grants in ${file} ignored: not a map of folders to features`,
    )
    // The next grant replaces what could not be read.
    await store.add(FOLDER, ['imageGeneration'])
    expect(store.read(FOLDER)).toEqual(new Set(['imageGeneration']))
  })
})
