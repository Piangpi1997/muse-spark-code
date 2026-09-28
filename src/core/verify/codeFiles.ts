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
//   rules allow. Naming is judged conservatively (PR #54, fourth Codex
//   round): a command is split into words only when it holds nothing a
//   shell could read otherwise (quotes, escapes, variables, substitutions,
//   globs, operators); a command that does is taken to run any edited file.
//   An edited file's path found anywhere in the command's text counts too.
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
// A word of a command that no shell (bash, PowerShell, cmd.exe) reads as
// anything but itself: letters, digits and `_ . / : + -`, and `=` between an
// option and its value. Anything else (quotes, `\`, `` ` ``, `$`, `%`, `@`
// and `,` (PowerShell's splatting and arrays), `*?[]{}`, `~`, `!`, `#`, `^`,
// `()`, `;&|<>`) makes the command's words uncertain.
const PLAIN_WORD = /^[\w./:+=-]+$/
const OPTION_VALUE = '='

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

/**
 * The command's words as paths (a leading `./` dropped, an option's value
 * after `=` taken apart), or undefined when a shell could read them
 * otherwise and they cannot be told with certainty.
 */
function commandPaths(command: string): readonly string[] | undefined {
  const words = command.split(WHITESPACE).filter((word) => word !== '')
  return words.some((word) => !PLAIN_WORD.test(word))
    ? undefined
    : words
        .flatMap((word) => word.split(OPTION_VALUE))
        .map((word) => word.replace(LEADING_DOT_SLASH, '').toLowerCase())
        .filter((word) => word !== '')
}

/**
 * Whether editing this file may change what `command` runs: a file that
 * loads code, one that defines commands, one whose path (either slash form)
 * occurs in the command's text, one a word of the command names (by its
 * path or its name), or any file when the command's words cannot be told
 * with certainty. Compared without case, so it errs towards asking.
 */
export function canChangeWhatRuns(relativePath: string, command: string): boolean {
  const path = relativePath.replaceAll(BACKSLASH, () => SEGMENT_SEPARATOR).toLowerCase()
  const name = baseName(path)
  const text = command.toLowerCase()
  const paths = commandPaths(command)
  return (
    isCodeLoading(relativePath) ||
    COMMAND_DEFINING_FILES.has(name) ||
    text.includes(path) ||
    text.includes(path.replaceAll(SEGMENT_SEPARATOR, () => '\\')) ||
    paths === undefined ||
    paths.some((word) => word === path || baseName(word) === name)
  )
}
