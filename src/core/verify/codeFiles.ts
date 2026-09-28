// Which files decide what code runs (the M68 review), for the verify loop.
//
// - A file the editor's own tools load and run as code when another file is
//   shown or formatted: a linter's or formatter's JavaScript configuration,
//   a data configuration that can name a plugin by a local path, the package
//   manifest (formatter plugins), installed packages. The loop never shows or
//   formats one, and a turn that wrote one shows and formats nothing more
//   until the user's next message: showing any file lints it with the
//   workspace's configuration.
// - A file that decides what a check command runs: those above, a package
//   script's or a build tool's definition, or a file the command names. A
//   turn that edited one asks again for the checks, whatever the session's
//   rules allow.
//
// Pure: paths are workspace-relative with forward slashes.

import {
  CODE_LOADING_FILE_PATTERNS,
  COMMAND_DEFINING_FILES,
  INSTALLED_PACKAGES_DIR,
} from '../../shared/constants'

const SEGMENT_SEPARATOR = '/'
const LEADING_DOT_SLASH = /^\.\//
const BACKSLASH = /\\/g
const WHITESPACE = /\s+/
const QUOTES = /^["']|["']$/g

function segmentsOf(relativePath: string): readonly string[] {
  return relativePath.replaceAll(BACKSLASH, () => SEGMENT_SEPARATOR).split(SEGMENT_SEPARATOR)
}

function baseName(relativePath: string): string {
  return segmentsOf(relativePath).at(-1) ?? relativePath
}

/** Whether the editor's own tools load this file as code (see above). */
export function isCodeLoading(relativePath: string): boolean {
  const name = baseName(relativePath)
  return (
    segmentsOf(relativePath).some((segment) => segment.toLowerCase() === INSTALLED_PACKAGES_DIR) ||
    CODE_LOADING_FILE_PATTERNS.some((pattern) => pattern.test(name))
  )
}

/** The command's words as paths: quotes and a leading `./` dropped, forward slashes. */
function commandPaths(command: string): readonly string[] {
  return command
    .split(WHITESPACE)
    .map((word) =>
      word
        .replaceAll(QUOTES, '')
        .replaceAll(BACKSLASH, () => SEGMENT_SEPARATOR)
        .replace(LEADING_DOT_SLASH, '')
        .toLowerCase(),
    )
    .filter((word) => word !== '')
}

/**
 * Whether editing this file may change what `command` runs: a file that
 * loads code, one that defines commands, or one the command names (by its
 * path or its name). Compared without case, so it errs towards asking.
 */
export function canChangeWhatRuns(relativePath: string, command: string): boolean {
  const path = relativePath.toLowerCase()
  const name = baseName(path)
  return (
    isCodeLoading(relativePath) ||
    COMMAND_DEFINING_FILES.has(name) ||
    commandPaths(command).some((word) => word === path || baseName(word) === name)
  )
}
