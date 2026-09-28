// Whole-file writes that never leave a half-written file (PLAN.md D26, D27):
// the content goes to a temporary file beside the target, which is renamed
// over it. A rename Windows refuses while an indexer or a virus scanner
// holds the target is tried again, the wait doubling; the temporary file of
// a write that fails is removed.
//
// A rename replaces the directory entry, so an existing file is replaced
// where it really is (through a symbolic link, the file it leads to) and
// keeps its permission bits; a read-only file is refused, as a write in
// place would be. What a new inode cannot carry is not carried: the other
// names of a hard-linked file keep the old content (which is what keeps a
// package manager's shared store intact), the owner is the writer, and
// Windows' hidden and system attributes are not copied.

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, link, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isSamePath } from '../core/paths'
import {
  ATOMIC_RENAME_ATTEMPTS,
  ATOMIC_RENAME_DELAY_MS,
  ATOMIC_TEMPORARY_SUFFIX,
  MODEL_TEXT,
} from '../shared/constants'
import { canonicalPath } from './canonicalPath'

export interface AtomicWriteOptions {
  /** Waits between rename attempts; injectable so tests do not sleep. */
  readonly sleep: (ms: number) => Promise<void>
  /** `fs.rename`; tests stand in a scanner holding the file. */
  readonly rename?: (from: string, to: string) => Promise<void>
  /** `fs.realpath`; tests stand in a symbolic link where the OS makes none without privilege. */
  readonly realPath?: (target: string) => Promise<string>
  /** Model API tools require the operation to keep its approved canonical target. */
  readonly expectedCanonicalPath?: string
  readonly platform?: NodeJS.Platform
}

// The bits `chmod` sets: setuid, setgid, sticky and the three rwx triads.
const PERMISSION_BITS = 0o7777

interface Destination {
  readonly path: string
  /** The replaced file's permission bits; undefined for a new file. */
  readonly mode?: number
}

// What Windows answers while another program holds the target.
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY'])

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

/** Renames `from` over `to`, again while Windows reports the target busy. */
export async function renameReplacing(
  from: string,
  to: string,
  options: AtomicWriteOptions,
  beforeAttempt?: () => Promise<void>,
): Promise<void> {
  const renameFile = options.rename ?? rename
  for (let attempt = 1; ; attempt += 1) {
    try {
      await beforeAttempt?.()
      await renameFile(from, to)
      return
    } catch (error: unknown) {
      const code = errorCode(error)
      if (
        code === undefined ||
        !RENAME_RETRY_CODES.has(code) ||
        attempt >= ATOMIC_RENAME_ATTEMPTS
      ) {
        throw error
      }
      await options.sleep(ATOMIC_RENAME_DELAY_MS * 2 ** (attempt - 1))
    }
  }
}

/** Refuse a checked target whose parent was replaced by a link or junction. */
async function assertBoundPath(
  actualPath: string,
  expectedPath: string,
  options: AtomicWriteOptions,
): Promise<void> {
  if (options.expectedCanonicalPath === undefined) {
    return
  }
  const canonical = await canonicalPath(actualPath)
  if (!isSamePath(canonical, expectedPath, options.platform ?? process.platform)) {
    throw new Error(MODEL_TEXT.pathChangedAfterApproval)
  }
}

/**
 * Where a write of `target` lands: an existing file where it really is,
 * with its permission bits, refused when it is read-only (EACCES, or EPERM
 * on Windows); `target` itself for a new file or a link that leads nowhere.
 */
async function destinationOf(target: string, options: AtomicWriteOptions): Promise<Destination> {
  let real: string
  try {
    real = await (options.realPath ?? realpath)(target)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return { path: target }
    }
    throw error
  }
  await access(real, constants.W_OK)
  const { mode } = await stat(real)
  return { path: real, mode: mode & PERMISSION_BITS }
}

/**
 * Replaces `target` with `content` (UTF-8) in one step, its folder created.
 * The temporary file's name is unique, so two windows writing the same
 * target never share one; it ends in ATOMIC_TEMPORARY_SUFFIX for cleanups.
 */
export async function writeFileAtomically(
  target: string,
  content: string,
  options: AtomicWriteOptions,
): Promise<void> {
  await assertBoundPath(target, options.expectedCanonicalPath ?? target, options)
  await mkdir(path.dirname(target), { recursive: true })
  await assertBoundPath(target, options.expectedCanonicalPath ?? target, options)
  const destination = await destinationOf(target, options)
  await assertBoundPath(destination.path, options.expectedCanonicalPath ?? target, options)
  const temporary = `${destination.path}.${randomUUID()}${ATOMIC_TEMPORARY_SUFFIX}`
  let temporaryIdentity: { readonly dev: number; readonly ino: number } | undefined
  try {
    await assertBoundPath(temporary, temporary, options)
    const handle = await open(temporary, 'wx')
    try {
      const held = await handle.stat()
      // The content is written through this handle only after path and inode
      // agree twice. Node cannot make a path-based rename handle-relative.
      for (let sample = 0; sample < 2; sample += 1) {
        await assertBoundPath(temporary, temporary, options)
        const current = await stat(temporary)
        if (held.dev !== current.dev || held.ino !== current.ino) {
          throw new Error(MODEL_TEXT.pathChangedAfterApproval)
        }
      }
      temporaryIdentity = { dev: held.dev, ino: held.ino }
      await handle.writeFile(content, 'utf8')
      if (destination.mode !== undefined) {
        await handle.chmod(destination.mode)
      }
    } finally {
      await handle.close()
    }
    await renameReplacing(temporary, destination.path, options, async () => {
      await assertBoundPath(temporary, temporary, options)
      await assertBoundPath(destination.path, options.expectedCanonicalPath ?? target, options)
      const current = await stat(temporary)
      if (current.dev !== temporaryIdentity?.dev || current.ino !== temporaryIdentity.ino) {
        throw new Error(MODEL_TEXT.pathChangedAfterApproval)
      }
      await assertBoundPath(temporary, temporary, options)
      await assertBoundPath(destination.path, options.expectedCanonicalPath ?? target, options)
    })
  } catch (error: unknown) {
    // A retargeted directory must not make cleanup delete a different file.
    try {
      await assertBoundPath(temporary, temporary, options)
      const current = await stat(temporary)
      if (current.dev === temporaryIdentity?.dev && current.ino === temporaryIdentity.ino) {
        await rm(temporary, { force: true })
      }
    } catch {
      // Preserve the original write failure; a moved temp may be left behind.
    }
    throw error
  }
}

export interface NewFileOptions {
  /** The file's mode before the umask; the file keeps the stage's inode. */
  readonly mode: number
  /**
   * The folder's canonical form, links resolved, that the file must land
   * in: the checked one when the caller confined the path already, else the
   * folder's form when the create starts.
   */
  readonly expectedDirectory?: string
  /**
   * A stage that could not be removed: `isPublished` says whether the file
   * was published first (complete under its name) or the create failed.
   */
  readonly warn: (stage: string, isPublished: boolean, error: unknown) => void
  /** Replace the hard-link call in a deterministic publication test. */
  readonly publish?: (stage: string, target: string) => Promise<void>
  /** Waits between removal attempts; injectable so tests do not sleep. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Removes the stage (`fs.rm`); tests stand in a scanner holding it. */
  readonly remove?: (stage: string) => Promise<void>
  /** Runs once the stage is written and closed, before the last check; tests swap the folder here. */
  readonly staged?: () => Promise<void>
  readonly platform?: NodeJS.Platform
}

const NAME_TAKEN_ERROR = 'NameTakenError'
// What the hard link answers when the name is taken.
const NAME_TAKEN_CODE = 'EEXIST'
// What mkdir answers when a part of the folder's path is a file.
const NOT_A_FOLDER_CODES: ReadonlySet<string> = new Set(['EEXIST', 'ENOTDIR'])

/**
 * The target's name was taken when the file was to be published: nothing
 * was written. It keeps `code: 'EEXIST'`, as the link's own error had it.
 */
class NameTakenError extends Error {
  public readonly code = NAME_TAKEN_CODE

  public constructor(target: string, cause: unknown) {
    super(`${target} exists already`, { cause })
    this.name = NAME_TAKEN_ERROR
  }
}

/** Whether `createFileExclusively` found the name taken (and nothing else went wrong). */
export function isNameTaken(error: unknown): boolean {
  return error instanceof Error && error.name === NAME_TAKEN_ERROR
}

/** Refuses a folder that now leads somewhere else than it did when it was checked. */
async function assertSameDirectory(
  directory: string,
  expected: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (!isSamePath(await canonicalPath(directory), expected, platform)) {
    throw new Error(`${directory} now leads elsewhere through a link`)
  }
}

function removeFile(target: string): Promise<void> {
  return rm(target, { force: true })
}

/** Removes a stage, again while Windows reports it held (a scanner, an indexer). */
async function removeStage(
  stage: string,
  sleep: (ms: number) => Promise<void>,
  remove: (stage: string) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await remove(stage)
      return
    } catch (error: unknown) {
      const code = errorCode(error)
      if (
        code === undefined ||
        !RENAME_RETRY_CODES.has(code) ||
        attempt >= ATOMIC_RENAME_ATTEMPTS
      ) {
        throw error
      }
      await sleep(ATOMIC_RENAME_DELAY_MS * 2 ** (attempt - 1))
    }
  }
}

/**
 * Creates `absolutePath` with `content` (UTF-8), its folder made, and never
 * replaces a file already there: the content goes to a hidden stage beside
 * it, which a hard link then publishes under the target name. A taken name
 * is a `NameTakenError` (see `isNameTaken`), so a reader never sees half a
 * file and another writer's file is never replaced. File systems without
 * hard links fail closed; copy and rename cannot make both guarantees.
 *
 * The folder is checked against `expectedDirectory` after it is made and
 * again just before the link, so a folder swapped for a link or junction in
 * between is refused. Node cannot link relative to a held folder handle, so
 * a swap between that last check and the link itself stays outside the
 * guarantee, as for `writeFileAtomically`.
 */
export async function createFileExclusively(
  absolutePath: string,
  content: string,
  options: NewFileOptions,
): Promise<void> {
  const platform = options.platform ?? process.platform
  const sleep = options.sleep ?? delay
  const directory = path.dirname(absolutePath)
  const expected = options.expectedDirectory ?? (await canonicalPath(directory))
  try {
    await mkdir(directory, { recursive: true })
  } catch (error: unknown) {
    const code = errorCode(error)
    if (code !== undefined && NOT_A_FOLDER_CODES.has(code)) {
      throw new Error(`${directory} is not a folder`, { cause: error })
    }
    throw error
  }
  await assertSameDirectory(directory, expected, platform)
  const stage = path.join(
    directory,
    `.${path.basename(absolutePath)}.${randomUUID()}${ATOMIC_TEMPORARY_SUFFIX}`,
  )
  let hasOwnedStage = false
  let isPublished = false
  try {
    const handle = await open(stage, 'wx', options.mode)
    hasOwnedStage = true
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await options.staged?.()
    await assertSameDirectory(directory, expected, platform)
    try {
      await (options.publish ?? link)(stage, absolutePath)
    } catch (error: unknown) {
      throw errorCode(error) === NAME_TAKEN_CODE ? new NameTakenError(absolutePath, error) : error
    }
    isPublished = true
  } finally {
    if (hasOwnedStage) {
      try {
        await removeStage(stage, sleep, options.remove ?? removeFile)
      } catch (error: unknown) {
        // A published file is complete whatever happens to its stage; a
        // stage left beside it is swept later (plans) or harmless (memory).
        options.warn(stage, isPublished, error)
      }
    }
  }
}
