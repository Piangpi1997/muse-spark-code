// Muse Code's OS sandbox for shell tools. On Windows the CLI needs a one-time
// elevated `muse sandbox windows setup` (it creates the local sandbox users,
// their capabilities and a Windows Filtering Platform rule under
// C:\ProgramData\muse); until then every shell tool call fails with
// "sandbox enforcement unavailable". `muse sandbox windows check` prints
// `key=value` lines and exits 1 while setup is required (verified 2026-09-22
// on Muse Code 1.3.0). Linux and macOS have no sandbox subcommand and need no
// setup. This module is pure: the host runs the processes it describes.

import path from 'node:path'
import {
  MUSE_DISABLE_SANDBOX_ARG,
  MUSE_DISABLE_SHELL_ARG,
  MUSE_SANDBOX_CHECK_ARGS,
  MUSE_SANDBOX_NETWORK_ARG,
  MUSE_SANDBOX_SETUP_ARGS,
  MUSE_SERVE_ARGS,
  MUSE_TRUST_WORKSPACE_ARG,
  type SandboxNetworkMode,
  SANDBOX_STATUS_READY,
  SANDBOX_STATUS_SETUP_REQUIRED,
  type ShellSandboxMode,
  WINDOWS_POWERSHELL_COMMAND_ARGS,
  WINDOWS_POWERSHELL_RELATIVE_PATH,
} from '../../../shared/constants'
import type { MuseLaunch } from './launch'

const SANDBOX_STATUS_UNKNOWN = 'unknown'

export type SandboxStatus =
  typeof SANDBOX_STATUS_READY | typeof SANDBOX_STATUS_SETUP_REQUIRED | typeof SANDBOX_STATUS_UNKNOWN

export interface SandboxCheck {
  readonly status: SandboxStatus
  /** The CLI's `reason=` line, present while setup is required. */
  readonly reason: string | undefined
  /** The `diagnostic=` lines, one per finding. */
  readonly diagnostics: readonly string[]
}

export interface CliInvocation {
  readonly command: string
  readonly args: readonly string[]
}

const STATUS_KEY = 'status'
const REASON_KEY = 'reason'
const DIAGNOSTIC_KEY = 'diagnostic'
const LINE_BREAK = /\r?\n/
const KEY_VALUE_SEPARATOR = '='

function toStatus(value: string): SandboxStatus {
  return value === SANDBOX_STATUS_READY || value === SANDBOX_STATUS_SETUP_REQUIRED
    ? value
    : SANDBOX_STATUS_UNKNOWN
}

interface SandboxCheckDraft {
  status: SandboxStatus
  reason: string | undefined
  readonly diagnostics: string[]
}

/** Folds one `key=value` line into the draft; lines without a key are noise. */
function applyReportLine(draft: SandboxCheckDraft, line: string): void {
  const separator = line.indexOf(KEY_VALUE_SEPARATOR)
  if (separator <= 0) {
    return
  }
  const key = line.slice(0, separator).trim()
  const value = line.slice(separator + 1).trim()
  switch (key) {
    case STATUS_KEY: {
      draft.status = toStatus(value)
      break
    }
    case REASON_KEY: {
      draft.reason = value
      break
    }
    case DIAGNOSTIC_KEY: {
      draft.diagnostics.push(value)
      break
    }
    default: {
      break
    }
  }
}

/** Parses the `key=value` report of `muse sandbox windows check`. */
export function parseSandboxCheck(output: string): SandboxCheck {
  const draft: SandboxCheckDraft = {
    status: SANDBOX_STATUS_UNKNOWN,
    reason: undefined,
    diagnostics: [],
  }
  for (const line of output.split(LINE_BREAK)) {
    applyReportLine(draft, line)
  }
  return draft
}

/**
 * The CLI the backend spawns, running `args` instead of its `serve …`
 * arguments. Keeps the PowerShell-launcher prefix when the resolver fell
 * back to it.
 */
export function museCliInvocation(launch: MuseLaunch, args: readonly string[]): CliInvocation {
  const prefixLength = launch.args.length - launch.serveArgs.length
  const suffix = launch.args.slice(prefixLength)
  if (suffix.join(' ') !== launch.serveArgs.join(' ')) {
    throw new Error(`Muse launch does not end with ${launch.serveArgs.join(' ')}`)
  }
  return { command: launch.command, args: [...launch.args.slice(0, prefixLength), ...args] }
}

export function sandboxCheckInvocation(launch: MuseLaunch): CliInvocation {
  return museCliInvocation(launch, MUSE_SANDBOX_CHECK_ARGS)
}

export function sandboxSetupInvocation(launch: MuseLaunch): CliInvocation {
  return museCliInvocation(launch, MUSE_SANDBOX_SETUP_ARGS)
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const root = path.win32.resolve(directory).toLowerCase()
  const target = path.win32.resolve(candidate).toLowerCase()
  return target === root || target.startsWith(`${root}${path.win32.sep}`)
}

/**
 * A Windows workspace under `C:\Users\<user>`, where Muse Code's sandbox runs
 * shell commands in PowerShell's own folder instead (meta-models/muse-code-sdk#26;
 * verified live on 1.3.0 on 2026-09-22 and on 1.4.0 on 2026-09-27). No release
 * has fixed it, so this holds for every version until one is verified; an
 * earlier version ceiling of 1.3.0 hid the warning on 1.4.0, which is still
 * affected (docs/certification/m4.md, release-0.9.1.md).
 */
export function isProfileWorkspace(
  platform: NodeJS.Platform,
  workspaceRoot: string,
  userProfileDir: string | undefined,
): boolean {
  return (
    platform === 'win32' &&
    userProfileDir !== undefined &&
    isInsideDirectory(userProfileDir, workspaceRoot)
  )
}

// Termux sets these in every process on Android; proot passes its parent
// environment through, so they stay visible inside a proot Ubuntu guest
// (M60). `PREFIX` alone proves nothing (build tools use the name too), so it
// counts only under Android's app-storage roots.
const TERMUX_PREFIX_VARIABLE = 'PREFIX'
const TERMUX_VERSION_VARIABLE = 'TERMUX_VERSION'
const ANDROID_ROOT_VARIABLE = 'ANDROID_ROOT'
const ANDROID_DATA_VARIABLE = 'ANDROID_DATA'
const ANDROID_APP_STORAGE_PREFIXES = ['/data/data/', '/data/user/'] as const

/**
 * Whether the extension host runs in Termux's Android runtime, directly or
 * under proot: Muse Code's OS sandbox has no namespaces to use there, so
 * every sandboxed shell call fails (M60, PLAN.md D12). A Termux-native host
 * (code-server started in Termux itself) is equally constrained, so it
 * counts too. Pure: the environment is injected, so the Termux, proot and
 * desktop branches are all unit-tested on any OS (PLAN.md D1a).
 */
export function isProotEnvironment(env: NodeJS.ProcessEnv): boolean {
  const prefix = env[TERMUX_PREFIX_VARIABLE] ?? ''
  return (
    ANDROID_APP_STORAGE_PREFIXES.some((root) => prefix.startsWith(root)) ||
    (env[TERMUX_VERSION_VARIABLE] ?? '') !== '' ||
    (env[ANDROID_ROOT_VARIABLE] ?? '') !== '' ||
    (env[ANDROID_DATA_VARIABLE] ?? '') !== ''
  )
}

export interface ShellSandboxProbe {
  /** `museSpark.shellSandbox`. */
  readonly mode: ShellSandboxMode
  readonly platform: NodeJS.Platform
  readonly workspaceRoot: string | undefined
  readonly userProfileDir: string | undefined
  /** `isProotEnvironment` on the extension host's environment. */
  readonly isProot: boolean
}

/**
 * Why the sandbox is on or off: the setting said so, `auto` turned it off
 * for a Windows profile workspace or a Termux/proot Linux host, or nothing
 * spoke and the CLI default (sandbox on) stands.
 */
export type ShellSandboxReason = 'setting' | 'profileWorkspace' | 'proot' | 'default'

export interface ShellSandboxPosture {
  readonly isSandboxed: boolean
  readonly reason: ShellSandboxReason
}

/** The `muse serve` posture for this window (fixed for the host's lifetime). */
export function resolveShellSandbox(probe: ShellSandboxProbe): ShellSandboxPosture {
  if (probe.mode === 'muse') {
    return { isSandboxed: true, reason: 'setting' }
  }
  if (probe.mode === 'off') {
    return { isSandboxed: false, reason: 'setting' }
  }
  // proot is Linux-only; the same variables leaking elsewhere must not switch
  // anything off. An explicit `muse` above still wins (the setting said so).
  if (probe.platform === 'linux' && probe.isProot) {
    return { isSandboxed: false, reason: 'proot' }
  }
  const isLimited =
    probe.workspaceRoot !== undefined &&
    isProfileWorkspace(probe.platform, probe.workspaceRoot, probe.userProfileDir)
  return isLimited
    ? { isSandboxed: false, reason: 'profileWorkspace' }
    : { isSandboxed: true, reason: 'default' }
}

/**
 * Whether `museSpark.sandboxNetwork` reaches the host (M56, PLAN.md D43):
 * a mode other than `default`, while the shell sandbox is on. Without the
 * sandbox Muse Code ignores the flag ("--disable-sandbox turns the sandbox
 * off entirely, so no sandbox network policy applies", captured 2026-09-25)
 * and commands have the network the user has.
 */
export function isSandboxNetworkApplied(
  mode: SandboxNetworkMode,
  posture: ShellSandboxPosture,
): boolean {
  return mode !== 'default' && posture.isSandboxed
}

/**
 * The `serve` arguments that install `posture`, the sandbox's network and
 * the workspace's trust on the host. A trusted workspace loads its rules and
 * skills (Muse Code's `--trust-workspace`); an untrusted one gets no rules,
 * no skills and no workspace shell, VS Code's Restricted Mode contract
 * (PLAN.md D13).
 */
export function serveArguments(
  posture: ShellSandboxPosture,
  isWorkspaceTrusted: boolean,
  network: SandboxNetworkMode,
): readonly string[] {
  return [
    ...MUSE_SERVE_ARGS,
    ...(posture.isSandboxed ? [] : [MUSE_DISABLE_SANDBOX_ARG]),
    ...(isSandboxNetworkApplied(network, posture) ? [MUSE_SANDBOX_NETWORK_ARG, network] : []),
    isWorkspaceTrusted ? MUSE_TRUST_WORKSPACE_ARG : MUSE_DISABLE_SHELL_ARG,
  ]
}

/** A PowerShell single-quoted literal; the only escape is a doubled quote. */
function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Runs `target` through Windows PowerShell's `Start-Process -Verb RunAs`, the
 * UAC prompt, and waits for it. The elevated process's exit code becomes the
 * PowerShell exit code; a declined prompt makes `Start-Process` throw, which
 * `-NonInteractive` turns into exit code 1. Its output is not capturable
 * across the elevation boundary, so the caller re-runs the check afterwards.
 */
export function elevatedInvocation(systemRoot: string, target: CliInvocation): CliInvocation {
  const argumentList = target.args.map((argument) => powerShellLiteral(argument)).join(',')
  const script = [
    `$process = Start-Process -FilePath ${powerShellLiteral(target.command)}`,
    `-ArgumentList @(${argumentList}) -Verb RunAs -Wait -PassThru;`,
    'exit $process.ExitCode',
  ].join(' ')
  return {
    command: path.win32.join(systemRoot, WINDOWS_POWERSHELL_RELATIVE_PATH),
    args: [...WINDOWS_POWERSHELL_COMMAND_ARGS, script],
  }
}
