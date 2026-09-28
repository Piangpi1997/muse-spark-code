import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFileExclusively, isNameTaken, writeFileAtomically } from '../../src/host/fsAtomic'
import { isSamePath } from '../../src/core/paths'
import { removeFolder } from './helpers/temporaryFolders'

const paths = { root: '' }

beforeAll(async () => {
  paths.root = await mkdtemp(path.join(tmpdir(), 'muse-atomic-'))
})

afterAll(() => removeFolder(paths.root))

const noWait = () => Promise.resolve()

/** A file-system error with its code, as Node raises one. */
function coded(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe('writeFileAtomically (D27)', () => {
  it('creates the folder, replaces the file and leaves no temporary file', async () => {
    const target = path.join(paths.root, 'nested', 'a.txt')
    const sleep = vi.fn(() => Promise.resolve())
    await writeFileAtomically(target, 'one', { sleep })
    await writeFileAtomically(target, 'two', { sleep })
    await expect(readFile(target, 'utf8')).resolves.toBe('two')
    expect(await readdir(path.dirname(target))).toEqual(['a.txt'])
    expect(sleep).not.toHaveBeenCalled()
  })

  it('tries a busy rename again, the wait doubling, then gives up and cleans up', async () => {
    const target = path.join(paths.root, 'busy', 'b.txt')
    let refusals = 1
    const sleep = vi.fn(() => Promise.resolve())
    await writeFileAtomically(target, 'ok', {
      sleep,
      rename: async (from, to) => {
        if (refusals > 0) {
          refusals -= 1
          throw coded('EBUSY')
        }
        await rename(from, to)
      },
    })
    await expect(readFile(target, 'utf8')).resolves.toBe('ok')
    expect(sleep.mock.calls).toEqual([[25]])
    await expect(
      writeFileAtomically(target, 'never', {
        sleep,
        rename: () => Promise.reject(coded('ENOSPC')),
      }),
    ).rejects.toThrow('ENOSPC')
    // The old content stands and the temporary file is gone.
    await expect(readFile(target, 'utf8')).resolves.toBe('ok')
    expect(await readdir(path.dirname(target))).toEqual(['b.txt'])
  })

  it('replaces the file a link leads to, never the link', async () => {
    // A stand-in link: Windows makes a file symbolic link only with a privilege.
    const folder = path.join(paths.root, 'linked')
    const real = path.join(folder, 'real.txt')
    const link = path.join(folder, 'link.txt')
    await writeFileAtomically(real, 'old', { sleep: noWait })
    await writeFileAtomically(link, 'new', {
      sleep: noWait,
      realPath: (target) => Promise.resolve(target === link ? real : target),
    })
    await expect(readFile(real, 'utf8')).resolves.toBe('new')
    expect(await readdir(folder)).toEqual(['real.txt'])
  })

  it.runIf(process.platform !== 'win32')(
    'keeps a real symbolic link and the permission bits of the file it replaces',
    async () => {
      const folder = path.join(paths.root, 'posix')
      const script = path.join(folder, 'run.sh')
      const link = path.join(folder, 'run-link.sh')
      await writeFileAtomically(script, 'echo old\n', { sleep: noWait })
      await chmod(script, 0o755)
      await symlink(script, link)
      await writeFileAtomically(link, 'echo new\n', { sleep: noWait })
      await expect(readFile(script, 'utf8')).resolves.toBe('echo new\n')
      const linkInfo = await lstat(link)
      const scriptInfo = await stat(script)
      expect(linkInfo.isSymbolicLink()).toBe(true)
      expect(scriptInfo.mode & 0o777).toBe(0o755)
    },
  )

  it('refuses a read-only file at once, leaving it as it was', async () => {
    const folder = path.join(paths.root, 'locked')
    const target = path.join(folder, 'c.txt')
    const sleep = vi.fn(() => Promise.resolve())
    await writeFileAtomically(target, 'kept', { sleep })
    await chmod(target, 0o444)
    try {
      await expect(writeFileAtomically(target, 'lost', { sleep })).rejects.toMatchObject({
        code: expect.stringMatching(/^(EACCES|EPERM)$/),
      })
      // Not a busy target: nothing is tried again.
      expect(sleep).not.toHaveBeenCalled()
      await expect(readFile(target, 'utf8')).resolves.toBe('kept')
      expect(await readdir(folder)).toEqual(['c.txt'])
    } finally {
      await chmod(target, 0o644)
    }
  })
})

describe('isSamePath (D27)', () => {
  it('ignores case and separators on Windows only', () => {
    expect(isSamePath(String.raw`C:\Ws\A.ts`, 'c:/ws/a.ts', 'win32')).toBe(true)
    expect(isSamePath(String.raw`C:\ws\a.ts`, String.raw`C:\ws\b.ts`, 'win32')).toBe(false)
    expect(isSamePath('/ws/A.ts', '/ws/a.ts', 'linux')).toBe(false)
    expect(isSamePath('/ws/./a.ts', '/ws/a.ts', 'darwin')).toBe(true)
  })
})

const quiet = () => undefined

/** What a promise rejected with; a promise that resolves fails the test. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected a failure')
}

describe('createFileExclusively (M79)', () => {
  it('publishes a new file and names a taken name as such, leaving the old file and no stage', async () => {
    const target = path.join(paths.root, 'new', 'plan.md')
    await createFileExclusively(target, 'first', { mode: 0o666, warn: quiet })
    const taken = createFileExclusively(target, 'second', { mode: 0o666, warn: quiet })
    await expect(taken).rejects.toMatchObject({ code: 'EEXIST' })
    expect(isNameTaken(await failureOf(taken))).toBe(true)
    await expect(readFile(target, 'utf8')).resolves.toBe('first')
    expect(await readdir(path.dirname(target))).toEqual(['plan.md'])
  })

  it('says a file where the folder should be is not a folder, never that the name is taken', async () => {
    const blocker = path.join(paths.root, 'blocked')
    await createFileExclusively(blocker, 'a file', { mode: 0o666, warn: quiet })
    const failed = await failureOf(
      createFileExclusively(path.join(blocker, 'plan.md'), 'x', { mode: 0o666, warn: quiet }),
    )
    expect(String(failed)).toMatch(/is not a folder/)
    expect(isNameTaken(failed)).toBe(false)
  })

  it('refuses a folder that leads elsewhere than the checked one, writing nothing there', async () => {
    const real = path.join(paths.root, 'real-plans')
    const elsewhere = path.join(paths.root, 'elsewhere')
    await createFileExclusively(path.join(elsewhere, 'keep.md'), 'keep', {
      mode: 0o666,
      warn: quiet,
    })
    const link = path.join(paths.root, 'swapped')
    await symlink(elsewhere, link, 'junction')
    // The folder was checked as `real-plans`; it now is a junction to `elsewhere`.
    const stages = vi.fn((stage: string) => rm(stage, { force: true }))
    const refused = createFileExclusively(path.join(link, 'plan.md'), 'x', {
      mode: 0o666,
      expectedDirectory: real,
      warn: quiet,
      remove: stages,
    })
    await expect(refused).rejects.toThrow(/now leads elsewhere/)
    expect(await readdir(elsewhere)).toEqual(['keep.md'])
    // Refused before a stage was written there, not after.
    expect(stages).not.toHaveBeenCalled()
  })

  it('refuses a folder swapped for a junction once the stage is written, publishing nothing', async () => {
    const folder = path.join(paths.root, 'late-swap')
    const elsewhere = path.join(paths.root, 'late-elsewhere')
    await createFileExclusively(path.join(elsewhere, 'keep.md'), 'keep', {
      mode: 0o666,
      warn: quiet,
    })
    const refused = createFileExclusively(path.join(folder, 'plan.md'), 'x', {
      mode: 0o666,
      warn: quiet,
      staged: async () => {
        await rename(folder, `${folder}-moved`)
        await symlink(elsewhere, folder, 'junction')
      },
    })
    await expect(refused).rejects.toThrow(/now leads elsewhere/)
    expect(await readdir(elsewhere)).toEqual(['keep.md'])
  })

  it('removes a held stage again, and says whether the file was published when it cannot', async () => {
    const target = path.join(paths.root, 'held', 'plan.md')
    let refusals = 2
    const sleep = vi.fn(() => Promise.resolve())
    const warn = vi.fn()
    await createFileExclusively(target, 'ok', {
      mode: 0o666,
      warn,
      sleep,
      remove: async (stage) => {
        if (refusals > 0) {
          refusals -= 1
          throw coded('EBUSY')
        }
        await rm(stage, { force: true })
      },
    })
    expect(warn).not.toHaveBeenCalled()
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(await readdir(path.dirname(target))).toEqual(['plan.md'])
    const stuck = path.join(paths.root, 'stuck', 'plan.md')
    await createFileExclusively(stuck, 'ok', {
      mode: 0o666,
      warn,
      sleep,
      remove: () => Promise.reject(coded('EPERM')),
    })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[1]).toBe(true)
    await expect(readFile(stuck, 'utf8')).resolves.toBe('ok')
  })
})
