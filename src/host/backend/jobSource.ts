// The C# the Windows job helpers share (M27's shell job assembly, M50's MCP
// stdio launcher): shipped as native/windows/MuseSparkMcpJob.cs and read
// once, when a helper is first built, instead of riding in the host bundle
// as a 12 KiB string (PLAN.md D6, the M55 size receipt). A missing or
// unreadable file fails that helper's preparation, which each helper already
// reports and falls back from.

import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** The file, relative to the extension's folder. */
export const JOB_SOURCE_FILE = path.join('native', 'windows', 'MuseSparkMcpJob.cs')

/** Reads the shipped source at most once per window. */
export function jobSourceReader(extensionPath: string): () => Promise<string> {
  let source: Promise<string> | undefined
  return () => (source ??= readFile(path.join(extensionPath, JOB_SOURCE_FILE), 'utf8'))
}
