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
//
// `writeFileIfUnchanged` is the one conditional write (the Codex review of
// PR #54, third round): the same steps, and immediately before each rename
// attempt the target's current bytes are read and hashed, and a target that
// no longer holds the expected text is left alone. A file system offers no
// compare-and-swap for a rename, so a change landing between that read and
// the rename itself (microseconds) would still be replaced: that window is
// the residual, recorded in PLAN.md §9.

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { isSamePath } from '../core/paths'
import { bytesFingerprint } from '../core/verify/fingerprint'
import {
  ATOMIC_RENAME_ATTEMPTS,
  ATOMIC_RENAME_DELAY_MS,
  ATOMIC_TEMPORARY_SUFFIX,
  MODEL_TEXT,
} from '../shared/constants'
import { canonicalPath } from './canonicalPath'
import type { ConditionalWrite } from '../core/backends/modelapi/tools'

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

/** The target no longer holds what a conditional write expected: nothing was written. */
class ChangedBeforeWriteError extends Error {}

/** Refuses a destination whose current text is not the expected text. */
async function assertUnchanged(destination: string, expectedFingerprint: string): Promise<void> {
  let bytes: Uint8Array
  try {
    bytes = await readFile(destination)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      throw new ChangedBeforeWriteError(MODEL_TEXT.fileChangedBeforeWrite)
    }
    throw error
  }
  if (bytesFingerprint(bytes) !== expectedFingerprint) {
    throw new ChangedBeforeWriteError(MODEL_TEXT.fileChangedBeforeWrite)
  }
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
  await writeAtomically(target, content, options, undefined)
}

/**
 * `writeFileAtomically`, only while `target` still holds the text whose
 * fingerprint is `expectedFingerprint` (`core/verify/fingerprint`): checked
 * immediately before each rename attempt. `changed`, and nothing written,
 * when it does not.
 */
export async function writeFileIfUnchanged(
  target: string,
  expectedFingerprint: string,
  content: string,
  options: AtomicWriteOptions,
): Promise<ConditionalWrite> {
  try {
    await writeAtomically(target, content, options, expectedFingerprint)
    return 'written'
  } catch (error: unknown) {
    if (error instanceof ChangedBeforeWriteError) {
      return 'changed'
    }
    throw error
  }
}

async function writeAtomically(
  target: string,
  content: string,
  options: AtomicWriteOptions,
  expectedFingerprint: string | undefined,
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
      // Last, so nothing but the rename itself follows the comparison.
      if (expectedFingerprint !== undefined) {
        await assertUnchanged(destination.path, expectedFingerprint)
      }
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
