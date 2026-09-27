// How a Windows job helper's C# (`jobSource.ts`) becomes a file in the
// extension's storage: named by the source's digest, compiled once by
// Windows PowerShell 5.1's `Add-Type`, moved into place, and the builds of
// earlier sources removed. M27's shell job assembly and M50's MCP launcher
// take the same steps with their own names and `Add-Type` options.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { powerShellQuoted } from '../../core/shellQuote'
import { WINDOWS_POWERSHELL_COMMAND_ARGS } from '../../shared/constants'
import { type RunProgram, windowsPowerShell } from '../processTree'

const SOURCE_EXTENSION = '.cs'
const DIGEST_LENGTH = 16

/** One helper's build. */
export interface JobBuild {
  /** The file name before the source's digest. */
  readonly stem: string
  /** The file name's extension, which `Add-Type`'s output has too. */
  readonly extension: string
  /** `Add-Type`'s options for this helper's output. */
  readonly addTypeOptions: string
  /** What the log calls the built file. */
  readonly label: string
  /** Whether a built file is already at a path. */
  readonly isPresent: (file: string) => Promise<boolean>
}

/** The built file's name for this source (the whole C#, the shared half included). */
export function jobFileName(build: JobBuild, csharp: string): string {
  const digest = createHash('sha256').update(csharp).digest('hex').slice(0, DIGEST_LENGTH)
  return `${build.stem}${digest}${build.extension}`
}

/** Compiles `csharp` to `target`. */
export async function compileJob(
  build: JobBuild,
  target: string,
  csharp: string,
  systemRoot: string,
  run: RunProgram,
): Promise<void> {
  const directory = path.dirname(target)
  await mkdir(directory, { recursive: true })
  // Unique names, so two windows compiling at once never share a file.
  const stem = path.join(directory, randomUUID())
  const source = `${stem}${SOURCE_EXTENSION}`
  const output = `${stem}${build.extension}`
  const powershell = windowsPowerShell(systemRoot)
  try {
    await writeFile(source, csharp, 'utf8')
    await run(
      powershell.file,
      [
        ...WINDOWS_POWERSHELL_COMMAND_ARGS,
        `Add-Type -Path ${powerShellQuoted(source)} -OutputAssembly ${powerShellQuoted(output)} ${build.addTypeOptions}`,
      ],
      powershell.env,
    )
    try {
      await rename(output, target)
    } catch (error: unknown) {
      // Another window put the same file in place first.
      if (!(await build.isPresent(target))) {
        throw error
      }
    }
  } finally {
    await rm(source, { force: true })
    await rm(output, { force: true })
  }
}

/**
 * Removes the builds of earlier sources beside `current`. One that another
 * window still has loaded cannot go and stays until a later start; that is
 * logged.
 */
export async function removeStaleJobs(
  build: JobBuild,
  current: string,
  log: (message: string) => void,
): Promise<void> {
  const directory = path.dirname(current)
  const currentName = path.basename(current)
  try {
    const names = await readdir(directory)
    for (const name of names) {
      if (name !== currentName && name.startsWith(build.stem) && name.endsWith(build.extension)) {
        await rm(path.join(directory, name), { force: true })
      }
    }
  } catch (error: unknown) {
    log(`an earlier ${build.label} could not be removed yet (${String(error)})`)
  }
}
