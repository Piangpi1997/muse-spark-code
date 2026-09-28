// Saved plans on the real file system (M79): the store over the host's plan
// I/O. A new file every time and never a replacement, the plan byte for
// byte, the plans folder confined to the workspace's own `.agents/plans`
// (a junction, which Windows makes without privilege, is refused), bounded
// reads, and the Plans… listing.

import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlanStore } from '../../src/core/plans/planStore'
import { createPlanIo } from '../../src/host/planFeatures'
import { PLAN_FILE_MAX_BYTES, PLAN_NAME_ATTEMPTS, UI_TEXT } from '../../src/shared/constants'
import { FakeLogOutputChannel } from './helpers/fakes'
import { CAPTURED_PLAN_BODY } from './helpers/m79Capture'
import { pdfFixture } from './helpers/pdfFixture'
import { removeFolder } from './helpers/temporaryFolders'

const paths = { root: '', outside: '' }
const NOON = new Date(2026, 8, 27, 12, 0, 0)
const log = new FakeLogOutputChannel()

beforeAll(async () => {
  paths.root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'muse-plans-')))
  paths.outside = path.join(paths.root, 'outside')
  await mkdir(paths.outside, { recursive: true })
})

afterAll(async () => {
  await removeFolder(paths.root)
})

async function workspace(name: string): Promise<{ root: string; store: PlanStore }> {
  const root = path.join(paths.root, name)
  await mkdir(root, { recursive: true })
  return {
    root,
    store: new PlanStore({
      workspaceRoot: root,
      platform: process.platform,
      io: createPlanIo(log),
    }),
  }
}

function plansFolder(root: string): string {
  return path.join(root, '.agents', 'plans')
}

describe('PlanStore on the file system (M79)', () => {
  it('saves the plan byte for byte to .agents/plans/<date>-<slug>.md', async () => {
    const { root, store } = await workspace('save')
    const saved = await store.save({
      title: 'Add a README',
      savedAt: NOON,
      text: CAPTURED_PLAN_BODY,
    })
    expect(saved).toEqual({
      fileName: '2026-09-27-add-a-readme.md',
      relativePath: '.agents/plans/2026-09-27-add-a-readme.md',
    })
    const written = await readFile(path.join(plansFolder(root), saved.fileName))
    expect(written.equals(Buffer.from(CAPTURED_PLAN_BODY, 'utf8'))).toBe(true)
    // No stage is left beside it.
    expect(await readdir(plansFolder(root))).toEqual([saved.fileName])
  })

  it('never replaces a file: a taken name gets the next numeric suffix', async () => {
    const { root, store } = await workspace('taken')
    await mkdir(plansFolder(root), { recursive: true })
    const first = path.join(plansFolder(root), '2026-09-27-x.md')
    await writeFile(first, 'the user’s own plan')
    const second = await store.save({ title: 'x', savedAt: NOON, text: 'new' })
    const third = await store.save({ title: 'x', savedAt: NOON, text: 'newer' })
    expect([second.fileName, third.fileName]).toEqual(['2026-09-27-x-2.md', '2026-09-27-x-3.md'])
    expect(await readFile(first, 'utf8')).toBe('the user’s own plan')
    expect(await readFile(path.join(plansFolder(root), second.fileName), 'utf8')).toBe('new')
  })

  it('gives up after the last numeric suffix rather than replace a file', async () => {
    const { root, store } = await workspace('full')
    await mkdir(plansFolder(root), { recursive: true })
    for (let attempt = 1; attempt <= PLAN_NAME_ATTEMPTS; attempt += 1) {
      const suffix = attempt === 1 ? '' : `-${String(attempt)}`
      await writeFile(path.join(plansFolder(root), `2026-09-27-x${suffix}.md`), 'taken')
    }
    await expect(store.save({ title: 'x', savedAt: NOON, text: 'new' })).rejects.toThrow(
      UI_TEXT.planNamesTaken,
    )
  })

  it('refuses a plans folder that leads elsewhere through a junction', async () => {
    const { root, store } = await workspace('linked')
    await mkdir(path.join(root, '.agents'), { recursive: true })
    const link = plansFolder(root)
    await symlink(paths.outside, link, 'junction')
    try {
      await expect(store.save({ title: 'x', savedAt: NOON, text: 'x' })).rejects.toThrow(
        /outside the workspace|through a link/,
      )
      await expect(store.list()).rejects.toThrow(/outside the workspace|through a link/)
      expect(await readdir(paths.outside)).toEqual([])
    } finally {
      await rm(link, { force: true })
    }
  })

  it('refuses a plans folder that leads to another folder of the workspace', async () => {
    const { root, store } = await workspace('linked-inside')
    const elsewhere = path.join(root, 'docs')
    await mkdir(elsewhere, { recursive: true })
    await mkdir(path.join(root, '.agents'), { recursive: true })
    const link = plansFolder(root)
    await symlink(elsewhere, link, 'junction')
    try {
      await expect(store.save({ title: 'x', savedAt: NOON, text: 'x' })).rejects.toThrow(
        /through a link/,
      )
      expect(await readdir(elsewhere)).toEqual([])
    } finally {
      await rm(link, { force: true })
    }
  })

  it('reads a plan back whole and bounded, and says why one cannot be', async () => {
    const { root, store } = await workspace('read')
    const saved = await store.save({
      title: 'Read me',
      savedAt: NOON,
      text: '# Read me\n\n1. One.',
    })
    const plan = await store.read(saved.fileName)
    expect(plan.relativePath).toBe('.agents/plans/2026-09-27-read-me.md')
    expect(plan.document).toEqual({ title: 'Read me', body: '# Read me\n\n1. One.' })
    expect(Buffer.from(plan.bytes).toString('utf8')).toBe('# Read me\n\n1. One.')
    await expect(store.read('2026-09-27-gone.md')).rejects.toThrow(UI_TEXT.planFileMissing)
    await writeFile(path.join(plansFolder(root), 'big.md'), 'x'.repeat(PLAN_FILE_MAX_BYTES + 1))
    await expect(store.read('big.md')).rejects.toThrow(UI_TEXT.textFileTooLarge)
    await writeFile(path.join(plansFolder(root), 'fake.md'), Buffer.from(pdfFixture(1)))
    await expect(store.read('fake.md')).rejects.toThrow(UI_TEXT.textFileInvalid)
    await expect(store.read('../escape.md')).rejects.toThrow(/not a plan file name/)
  })

  it('lists the plans newest first, by heading or name, and knows which it holds', async () => {
    const { root, store } = await workspace('list')
    expect(await store.list()).toEqual([])
    await store.save({ title: 'old', savedAt: new Date(2026, 8, 1, 12), text: '# Old one' })
    await store.save({ title: 'new', savedAt: NOON, text: '## Steps\n1. x' })
    await mkdir(path.join(plansFolder(root), 'folder.md'), { recursive: true })
    await writeFile(path.join(plansFolder(root), 'notes.txt'), 'not a plan')
    expect(await store.list()).toEqual([
      {
        fileName: '2026-09-27-new.md',
        relativePath: '.agents/plans/2026-09-27-new.md',
        title: '2026-09-27-new',
      },
      {
        fileName: '2026-09-01-old.md',
        relativePath: '.agents/plans/2026-09-01-old.md',
        title: 'Old one',
      },
    ])
    expect(await store.has('2026-09-27-new.md')).toBe(true)
    expect(await store.has('folder.md')).toBe(false)
    expect(await store.has('2026-09-27-none.md')).toBe(false)
  })
})
