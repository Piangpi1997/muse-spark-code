// Credential state for both backends, shared by every surface (PLAN.md D1,
// M7). The backend selection decides which credential counts: the Muse
// Code CLI's own sign-in (subscription) for the CLI backend, the pasted
// Model API key for the Model API backend; they are never mixed. `status`
// is the estimate from the credential facts (the CLI's from its credential
// file's structure, confirmed by the CLI when that is ambiguous, PLAN.md
// D26); a backend's own `authRequired` turn error overrides it through
// `markAuthRequired`. All VS Code interactions (terminals, input boxes) are
// injected so the flow is unit-tested end to end.

import { selectBackend } from '../../core/backendSelection'
import type { BackendKind } from '../../core/agent/agentBackend'
import type { CliSignIn } from '../../core/backends/musecode/credentialFile'
import {
  type BackendMode,
  MUSE_INSTALL_POLL_INTERVAL_MS,
  MUSE_INSTALL_TIMEOUT_MS,
  MUSE_LOGOUT_ARGS,
  UI_TEXT,
} from '../../shared/constants'
import { fill } from '../../shared/l10n/text'
import type { AuthStatus, HostToWebviewMessage, SignInMethod } from '../../shared/protocol'
import type { Logger } from '../logger'
import { isCliSignedIn } from './cliAccount'
import type { DeviceSignInEnded, DeviceSignInOutcome } from './deviceSignIn'
import type { CredentialStore } from './credentialStore'

export interface AuthBackendFacts {
  /** The CLI path to run for `login` / `logout`, or the reason it is absent. */
  readonly resolveCli: () =>
    | { readonly ok: true; readonly cliPath: string }
    | { readonly ok: false; readonly reason: string }
  /**
   * The CLI's own sign-in: its credential file's structure, and the CLI's
   * `account/read` when that cannot say. With `isUserAction` macOS may ask
   * too (its host reads the Keychain); otherwise it does not.
   */
  readonly cliSignIn: (isUserAction: boolean) => Promise<CliSignIn>
  /** Where the CLI keeps its sign-in, named when the file stops it starting. */
  readonly credentialFilePath: () => string
  readonly hasEnvironmentKey: () => boolean
  /** `museSpark.backend`. */
  readonly getBackendMode: () => BackendMode
  /**
   * Stop the running hosts so the next turn spawns the right one afresh;
   * with `isConversationEnding` (sign-out) the conversations are not resumed.
   */
  readonly restartBackend: (isConversationEnding: boolean) => Promise<void>
  /**
   * The CLI's own sign-out, MSP `account/logout` on a short-lived host: true
   * once `account/read` shows no stored credential in use. Never rejects.
   */
  readonly logOutCli: () => Promise<boolean>
}

export interface AuthServiceDeps {
  readonly backend: AuthBackendFacts
  readonly credentials: CredentialStore
  /** Extension-private, credential-free state retained across activation. */
  readonly logoutHold: {
    readonly get: () => boolean
    readonly set: (isHeld: boolean) => PromiseLike<void>
  }
  readonly runInTerminal: (cliPath: string, args: readonly string[]) => void
  readonly installCommand: string
  readonly runInstallerInTerminal: () => void
  readonly runDeviceSignIn: (
    signal: AbortSignal,
    onCode: (url: string, code: string) => void,
  ) => Promise<DeviceSignInOutcome>
  /** Returns the pasted key, or undefined when the user dismissed the box. */
  readonly promptForApiKey: () => Promise<string | undefined>
  readonly broadcast: (message: HostToWebviewMessage) => void
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly log: Logger
}

export interface AuthSnapshot {
  readonly status: AuthStatus
  readonly detail: string | undefined
  /** The backend the window uses (known once the facts are in). */
  readonly backend?: BackendKind | undefined
  /** The sign-in paths the gate offers. */
  readonly methods?: readonly SignInMethod[] | undefined
  readonly verificationUrl?: string | undefined
  readonly userCode?: string | undefined
  readonly hasCli?: boolean | undefined
  readonly hasCliSession?: boolean | undefined
  readonly installState?: 'running' | 'failed' | undefined
}

/**
 * What a conversation needs from the service: the controller's dependency
 * type, so a test hands it a plain object with exactly these members.
 */
export type AuthPort = Pick<
  AuthService,
  | 'current'
  | 'backend'
  | 'toMessage'
  | 'signIn'
  | 'installMuseCode'
  | 'cancelSignIn'
  | 'signOut'
  | 'refresh'
  | 'markAuthRequired'
  | 'markBackendError'
>

/**
 * The sign-in story for the log (M39): the state, the backend it chose and,
 * for an error, why. Written when the state or the backend changes.
 */
function signInLine(snapshot: AuthSnapshot): string {
  const backend = snapshot.backend === undefined ? '' : ` on the ${snapshot.backend} backend`
  const why =
    snapshot.status === 'error' && snapshot.detail !== undefined ? `: ${snapshot.detail}` : ''
  return `Sign-in state: ${snapshot.status}${backend}${why}`
}

/**
 * Why a device sign-in the host ended did not sign in (read when shown, D33):
 * the captured `expired` in its own words, any other ending as Muse Code
 * named it (AGENTS.md rule 13).
 */
function endedSignInText(ending: 'expired' | DeviceSignInEnded): string {
  return ending === 'expired'
    ? UI_TEXT.signInExpired
    : fill(UI_TEXT.signInEnded, { outcome: ending.endedAs })
}

export class AuthService {
  private snapshot: AuthSnapshot = { status: 'checking', detail: undefined }
  /** The browser sign-in in flight: a second click joins it (PLAN.md D25). */
  private deviceSignIn: Promise<AuthSnapshot> | undefined
  private installPromise: Promise<AuthSnapshot> | undefined
  /** Every panel joins one sign-out; the hold cannot be released by an earlier caller. */
  private signOutPromise: Promise<AuthSnapshot> | undefined
  private deviceAbort: AbortController | undefined
  /** A sign-out invalidates key prompts already open in any surface. */
  private signOutEpoch = 0
  /** Invalidates selectors across a same-kind sign-out/sign-in or key replacement. */
  private admissionGenerationValue = 0
  /** Sign-out waits for accepted key writes and backend restarts before ending sessions. */
  private readonly keyActivations = new Set<Promise<AuthSnapshot>>()
  private isLogoutHeld: boolean
  private isSigningOut = false
  private isLogoutPersistenceFailed = false

  public constructor(private readonly deps: AuthServiceDeps) {
    this.isLogoutHeld = deps.logoutHold.get()
  }

  private async setLogoutHold(isHeld: boolean): Promise<boolean> {
    this.isLogoutHeld = isHeld
    try {
      await this.deps.logoutHold.set(isHeld)
      this.isLogoutPersistenceFailed = false
      return true
    } catch {
      this.isLogoutPersistenceFailed = true
      this.deps.log.warn('Muse Code sign-out state could not be saved')
      return false
    }
  }

  private logoutDetail(): string {
    return this.isLogoutPersistenceFailed ? UI_TEXT.signOutHoldFailed : UI_TEXT.signOutPending
  }

  private async stopBackendForSignOut(): Promise<boolean> {
    try {
      await this.deps.backend.restartBackend(true)
      return true
    } catch {
      this.deps.log.warn('Muse Code backend could not stop during sign-out')
      return false
    }
  }

  private set(snapshot: AuthSnapshot): AuthSnapshot {
    const previous = this.snapshot
    this.snapshot = snapshot
    if (previous.status !== snapshot.status || previous.backend !== snapshot.backend) {
      this.deps.log.info(signInLine(snapshot))
    }
    this.deps.broadcast(this.toMessage())
    return this.snapshot
  }

  /**
   * The CLI's own credential as the gate counts it: `META_API_KEY` in its
   * environment (no file is looked at then), or its sign-in, including one
   * only the CLI could confirm.
   */
  private async cliCredential(
    isUserAction: boolean,
  ): Promise<{ readonly hasCliSession: boolean; readonly isKeychainElsewhere: boolean }> {
    if (this.deps.backend.hasEnvironmentKey()) {
      return { hasCliSession: true, isKeychainElsewhere: false }
    }
    const signIn = await this.deps.backend.cliSignIn(isUserAction)
    return {
      hasCliSession: isCliSignedIn(signIn),
      isKeychainElsewhere: signIn === 'keychainElsewhere',
    }
  }

  private async hasCliCredential(isUserAction: boolean): Promise<boolean> {
    const { hasCliSession } = await this.cliCredential(isUserAction)
    return hasCliSession
  }

  /** The backend selection from the current facts. */
  private async choose(isUserAction: boolean) {
    const cli = this.deps.backend.resolveCli()
    const { hasCliSession, isKeychainElsewhere } = await this.cliCredential(isUserAction)
    return {
      cli,
      hasCliSession,
      isKeychainElsewhere,
      choice: selectBackend({
        setting: this.deps.backend.getBackendMode(),
        hasCli: cli.ok,
        hasCliSession,
        hasStoredKey: (await this.deps.credentials.getApiKey()) !== undefined,
      }),
    }
  }

  /** A macOS Keychain pointer on Windows or Linux: `muse serve` exits at startup. */
  private keychainElsewhereText(): string {
    return fill(UI_TEXT.cliKeychainElsewhere, { path: this.deps.backend.credentialFilePath() })
  }

  /** One device-code sign-in process, however often the button is pressed (D25). */
  private async joinDeviceSignIn(): Promise<AuthSnapshot> {
    if (this.deviceSignIn !== undefined) {
      return await this.deviceSignIn
    }
    this.deviceSignIn = this.signInWithCli()
    try {
      return await this.deviceSignIn
    } finally {
      this.deviceSignIn = undefined
    }
  }

  private async signInWithCli(): Promise<AuthSnapshot> {
    const initial = this.snapshot
    const epoch = this.signOutEpoch
    const wasLogoutHeld = this.isLogoutHeld
    const cli = this.deps.backend.resolveCli()
    if (!cli.ok) {
      return await this.finishFailedCliSignIn(initial, 'noCli', cli.reason, 'warning')
    }
    // Cancel and sign-out reach this flow from here on, before any await.
    const abort = new AbortController()
    this.deviceAbort = abort
    this.set({ ...this.snapshot, status: 'signingIn', detail: UI_TEXT.signInWaiting })
    try {
      // The sign-in host could not start with that file either.
      const { isKeychainElsewhere } = await this.cliCredential(false)
      if (isKeychainElsewhere) {
        return await this.finishFailedCliSignIn(
          initial,
          'error',
          this.keychainElsewhereText(),
          'warning',
        )
      }
      // A cancel or sign-out during that look ends the flow before it starts.
      const outcome: DeviceSignInOutcome = abort.signal.aborted
        ? 'cancelled'
        : await this.deps.runDeviceSignIn(abort.signal, (url, code) => {
            if (abort.signal.aborted) {
              return
            }
            this.set({ ...this.snapshot, verificationUrl: url, userCode: code })
          })
      if (outcome === 'cancelled') {
        return await this.finishFailedCliSignIn(
          initial,
          'signedOut',
          UI_TEXT.signInCancelled,
          'info',
        )
      }
      if (outcome === 'timedOut') {
        return await this.finishFailedCliSignIn(
          initial,
          'signedOut',
          UI_TEXT.signInTimedOut,
          'warning',
        )
      }
      if (outcome !== 'signedIn') {
        return await this.finishFailedCliSignIn(
          initial,
          'signedOut',
          endedSignInText(outcome),
          'warning',
        )
      }
      if (this.isSigningOut) {
        return this.snapshot
      }
      // After a sign-out, only the CLI's own confirmation of the new sign-in
      // (the device runner's, then the file or `account/read` here) lifts the
      // hold, and never while a key would bill instead.
      if (
        wasLogoutHeld &&
        (this.deps.backend.hasEnvironmentKey() ||
          (await this.deps.credentials.getApiKey()) !== undefined ||
          (await this.deps.backend.cliSignIn(true)) !== 'signedIn')
      ) {
        return await this.refresh(true)
      }
      this.admissionGenerationValue += 1
      await this.deps.backend.restartBackend(initial.status === 'signedIn')
      if (wasLogoutHeld) {
        if (this.signOutEpoch !== epoch || this.deps.backend.hasEnvironmentKey()) {
          return await this.refresh(true)
        }
        const isHoldSaved = await this.setLogoutHold(false)
        if (!isHoldSaved) {
          return this.set({ ...this.snapshot, status: 'error', detail: UI_TEXT.signOutHoldFailed })
        }
      }
      return await this.refresh(true)
    } catch (error: unknown) {
      this.deps.log.warn(
        `In-panel sign-in failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      )
      return await this.finishFailedCliSignIn(initial, 'error', UI_TEXT.signInFailed, 'warning')
    } finally {
      this.deviceAbort = undefined
    }
  }

  private async finishFailedCliSignIn(
    initial: AuthSnapshot,
    status: 'noCli' | 'signedOut' | 'error',
    detail: string,
    noticeLevel: 'info' | 'warning',
  ): Promise<AuthSnapshot> {
    if (this.isLogoutHeld) {
      const refreshed = await this.refresh(true)
      this.deps.broadcast({ type: 'notice', level: noticeLevel, text: detail })
      return refreshed
    }
    if (initial.status === 'signedIn' && initial.backend === 'modelApi') {
      const refreshed = await this.refresh(true)
      this.deps.broadcast({ type: 'notice', level: noticeLevel, text: detail })
      return refreshed
    }
    return this.set({
      ...this.snapshot,
      status,
      detail,
      verificationUrl: undefined,
      userCode: undefined,
    })
  }

  private async refreshAfterCliDiscovery(epoch: number): Promise<AuthSnapshot> {
    const selected = await this.selectedSnapshot(true)
    if (epoch !== this.signOutEpoch) {
      return this.snapshot
    }
    if (
      this.snapshot.status === 'signedIn' &&
      this.snapshot.backend === 'modelApi' &&
      selected.status === 'signedIn' &&
      selected.backend === 'museCode'
    ) {
      // Auto selection crossed backends. Gate new hosts and retire the Model
      // API conversation before reporting a signed-in CLI host.
      this.admissionGenerationValue += 1
      this.set({ ...this.snapshot, status: 'checking', detail: undefined })
      try {
        await this.deps.backend.restartBackend(true)
      } catch {
        this.deps.log.warn('The Model API host could not stop after Muse Code installation')
        return this.set({
          ...this.snapshot,
          status: 'error',
          detail: UI_TEXT.signOutStopFailed,
          installState: 'failed',
        })
      }
      if (epoch !== this.signOutEpoch) {
        return this.snapshot
      }
    }
    return await this.refresh(true)
  }

  private async installWithCli(): Promise<AuthSnapshot> {
    const epoch = this.signOutEpoch
    if (this.deps.backend.resolveCli().ok) {
      return await this.refreshAfterCliDiscovery(epoch)
    }
    const shouldKeepModelApi =
      this.snapshot.status === 'signedIn' && this.snapshot.backend === 'modelApi'
    let status: AuthStatus = 'installing'
    let detail: string | undefined = UI_TEXT.installWaiting
    if (this.isLogoutHeld) {
      status = this.snapshot.status
      detail = this.snapshot.detail
    } else if (shouldKeepModelApi) {
      status = 'signedIn'
      detail = undefined
    }
    this.set({
      ...this.snapshot,
      status,
      detail,
      installState: 'running',
      hasCli: false,
    })
    try {
      this.deps.runInstallerInTerminal()
      const deadline = this.deps.now() + MUSE_INSTALL_TIMEOUT_MS
      while (this.deps.now() < deadline) {
        if (epoch !== this.signOutEpoch || this.isSigningOut) {
          return this.snapshot
        }
        if (this.deps.backend.resolveCli().ok) {
          return await this.refreshAfterCliDiscovery(epoch)
        }
        await this.deps.sleep(MUSE_INSTALL_POLL_INTERVAL_MS)
      }
      return await this.installFailed(UI_TEXT.installTimedOut, epoch)
    } catch (error: unknown) {
      this.deps.log.warn(
        `Muse Code installer terminal failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      )
      return await this.installFailed(UI_TEXT.installStartFailed, epoch)
    }
  }

  private async installFailed(detail: string, epoch: number): Promise<AuthSnapshot> {
    const selected = await this.selectedSnapshot(true)
    if (epoch !== this.signOutEpoch || this.isSigningOut) {
      return this.snapshot
    }
    if (this.isLogoutHeld) {
      this.deps.broadcast({ type: 'notice', level: 'warning', text: detail })
      return this.set({
        ...this.snapshot,
        status: 'error',
        detail: this.logoutDetail(),
        installState: 'failed',
      })
    }
    if (selected.hasCli === true) {
      return this.set(selected)
    }
    const failed = this.set({
      ...selected,
      detail,
      installState: 'failed',
    })
    if (failed.status === 'signedIn' && failed.backend === 'modelApi') {
      this.deps.broadcast({ type: 'notice', level: 'warning', text: detail })
    }
    return failed
  }

  /** Derive from current CLI, setting and SecretStorage facts. */
  private async selectedSnapshot(isUserAction: boolean): Promise<AuthSnapshot> {
    const { cli, hasCliSession, isKeychainElsewhere, choice } = await this.choose(isUserAction)
    if (choice.kind === undefined) {
      return {
        status: 'noCli',
        detail: cli.ok ? undefined : cli.reason,
        backend: undefined,
        methods: choice.methods,
        hasCli: cli.ok,
        hasCliSession,
      }
    }
    // Muse Code would be used but cannot start with its credential file:
    // said by name, not left to a host that exits at every message.
    const isBlocked = choice.kind === 'museCode' && cli.ok && isKeychainElsewhere
    return {
      status: isBlocked ? 'error' : choice.status,
      detail: isBlocked ? this.keychainElsewhereText() : undefined,
      backend: choice.kind,
      methods: choice.methods,
      hasCli: cli.ok,
      hasCliSession,
    }
  }

  private async activateApiKey(key: string, epoch: number): Promise<AuthSnapshot> {
    this.admissionGenerationValue += 1
    const previousKey = await this.deps.credentials.getApiKey()
    if (epoch !== this.signOutEpoch || this.isSigningOut) {
      return this.snapshot
    }
    const isReplacingActiveAccount =
      this.snapshot.status === 'signedIn' &&
      this.snapshot.backend === 'modelApi' &&
      previousKey !== key.trim()
    // Stop old turns while they still read the old key. A tool round must not
    // resume after SecretStorage begins returning the replacement key.
    if (isReplacingActiveAccount) {
      await this.deps.backend.restartBackend(true)
    }
    if (epoch !== this.signOutEpoch) {
      return this.snapshot
    }
    await this.deps.credentials.setApiKey(key)
    if (epoch !== this.signOutEpoch) {
      return this.snapshot
    }
    if (
      !isReplacingActiveAccount &&
      (this.snapshot.status !== 'signedIn' || this.snapshot.backend !== 'museCode')
    ) {
      await this.deps.backend.restartBackend(false)
    }
    const selected = await this.selectedSnapshot(true)
    return epoch === this.signOutEpoch ? this.set(selected) : this.snapshot
  }

  /**
   * The CLI's own sign-out: `account/logout` on a short-lived host, else
   * `muse logout` in a terminal (confirmed later, by the file or the CLI).
   * Returns false when that terminal could not open.
   */
  private async logOutCli(cliPath: string): Promise<boolean> {
    if (await this.deps.backend.logOutCli()) {
      return true
    }
    this.deps.log.warn('Muse Code did not sign out through its account host; running muse logout')
    try {
      this.deps.runInTerminal(cliPath, MUSE_LOGOUT_ARGS)
      return true
    } catch {
      this.deps.log.warn('Muse Code logout terminal could not open')
      return false
    }
  }

  private async performSignOut(): Promise<AuthSnapshot> {
    this.signOutEpoch += 1
    this.admissionGenerationValue += 1
    this.isSigningOut = true
    this.set({
      ...this.snapshot,
      status: 'error',
      detail: UI_TEXT.signOutPending,
      verificationUrl: undefined,
      userCode: undefined,
    })
    this.cancelSignIn()
    const hasPendingSignIn = this.deviceSignIn !== undefined || this.keyActivations.size > 0
    const stopping = this.stopBackendForSignOut()
    try {
      const isHoldSaved = await this.setLogoutHold(true)
      if (this.deviceSignIn !== undefined) {
        await this.deviceSignIn
      }
      await Promise.allSettled(this.keyActivations)
      let isHostStopped = await stopping
      if (hasPendingSignIn || !isHostStopped) {
        isHostStopped = await this.stopBackendForSignOut()
      }
      let isKeyClearFailed = false
      try {
        await this.deps.credentials.clearApiKey()
      } catch {
        isKeyClearFailed = true
        this.deps.log.warn('Stored Model API key could not be cleared during sign-out')
      }
      const cli = this.deps.backend.resolveCli()
      const isTerminalUnavailable =
        cli.ok &&
        isCliSignedIn(await this.deps.backend.cliSignIn(true)) &&
        !(await this.logOutCli(cli.cliPath))
      // `muse logout` rewrites the file rather than deleting it: what is in
      // it, or the CLI's own answer, says whether a sign-in remains.
      const hasCliCredential = await this.hasCliCredential(true)
      const hasStoredKey =
        isKeyClearFailed || (await this.deps.credentials.getApiKey()) !== undefined
      const shouldKeepHold = hasCliCredential || hasStoredKey || !isHostStopped
      const isReleaseSaved = shouldKeepHold || (await this.setLogoutHold(false))
      let detail: string | undefined
      if (!isHostStopped) {
        detail = UI_TEXT.signOutStopFailed
      } else if (isKeyClearFailed) {
        detail = UI_TEXT.signOutKeyClearFailed
      } else if (!isHoldSaved || !isReleaseSaved) {
        detail = UI_TEXT.signOutHoldFailed
      } else if (isTerminalUnavailable) {
        detail = UI_TEXT.signOutTerminalFailed
      } else if (shouldKeepHold) {
        detail = UI_TEXT.signOutPending
      }
      return this.set({
        ...this.snapshot,
        status:
          !isHostStopped || isKeyClearFailed || !isHoldSaved || !isReleaseSaved
            ? 'error'
            : 'signedOut',
        detail,
        verificationUrl: undefined,
        userCode: undefined,
        installState: undefined,
        hasCliSession: hasCliCredential,
      })
    } finally {
      this.isSigningOut = false
    }
  }

  public cancelSignIn(): void {
    this.deviceAbort?.abort()
  }

  /** One visible installer terminal and one location watch per window. */
  public async installMuseCode(): Promise<AuthSnapshot> {
    if (this.isSigningOut) {
      return this.snapshot
    }
    if (this.installPromise !== undefined) {
      return await this.installPromise
    }
    this.installPromise = this.installWithCli()
    try {
      return await this.installPromise
    } finally {
      this.installPromise = undefined
    }
  }

  public get current(): AuthSnapshot {
    return this.snapshot
  }

  /** The backend the next conversation runs on; undefined without any credential. */
  public get backend(): BackendKind | undefined {
    return this.snapshot.status === 'signedIn' &&
      !this.isLogoutHeld &&
      !this.isSigningOut &&
      this.keyActivations.size === 0 &&
      !this.isLogoutPersistenceFailed
      ? this.snapshot.backend
      : undefined
  }

  public get admissionGeneration(): number {
    return this.admissionGenerationValue
  }

  public toMessage(): HostToWebviewMessage {
    return {
      type: 'authState',
      status: this.snapshot.status,
      ...(this.snapshot.detail !== undefined && { detail: this.snapshot.detail }),
      ...(this.snapshot.backend !== undefined && { backend: this.snapshot.backend }),
      ...(this.snapshot.methods !== undefined && { methods: [...this.snapshot.methods] }),
      ...(this.snapshot.verificationUrl !== undefined && {
        verificationUrl: this.snapshot.verificationUrl,
      }),
      ...(this.snapshot.userCode !== undefined && { userCode: this.snapshot.userCode }),
      installCommand: this.deps.installCommand,
      ...(this.snapshot.hasCli !== undefined && { hasCli: this.snapshot.hasCli }),
      ...(this.snapshot.hasCliSession !== undefined && {
        hasCliSession: this.snapshot.hasCliSession,
      }),
      ...(this.snapshot.installState !== undefined && { installState: this.snapshot.installState }),
    }
  }

  /**
   * Re-derive the status from the CLI, credential and setting facts, then
   * broadcast. `isUserAction` (Check again, a sign-in or sign-out) lets
   * macOS ask the CLI about a Keychain sign-in; opening a panel does not.
   */
  public async refresh(isUserAction = false): Promise<AuthSnapshot> {
    const epoch = this.signOutEpoch
    const selected = await this.selectedSnapshot(isUserAction)
    if (this.isSigningOut || this.signOutEpoch !== epoch) {
      return this.set({ ...selected, status: 'error', detail: this.logoutDetail() })
    }
    if (!this.isLogoutHeld) {
      return this.set(selected)
    }
    const hasCliCredential = await this.hasCliCredential(isUserAction)
    const hasStoredKey = (await this.deps.credentials.getApiKey()) !== undefined
    if (this.signOutEpoch !== epoch) {
      return this.set({ ...selected, status: 'error', detail: this.logoutDetail() })
    }
    if (hasCliCredential || hasStoredKey) {
      return this.set({ ...selected, status: 'error', detail: this.logoutDetail() })
    }
    const isHoldSaved = await this.setLogoutHold(false)
    if (!isHoldSaved) {
      return this.set({ ...selected, status: 'error', detail: UI_TEXT.signOutHoldFailed })
    }
    const current = await this.selectedSnapshot(isUserAction)
    const hasCurrentCredential =
      (await this.hasCliCredential(isUserAction)) ||
      (await this.deps.credentials.getApiKey()) !== undefined
    if (hasCurrentCredential || this.signOutEpoch !== epoch || current.status === 'signedIn') {
      await this.setLogoutHold(true)
      return this.set({ ...current, status: 'error', detail: this.logoutDetail() })
    }
    return this.set(current)
  }

  public async signIn(method: SignInMethod): Promise<AuthSnapshot> {
    if (this.isSigningOut) {
      return this.snapshot
    }
    const epoch = this.signOutEpoch
    if (this.isLogoutHeld) {
      // A sign-in the CLI still holds after sign-out can be replaced only by
      // an explicit new browser approval, with no key that would bill instead.
      const canRecoverCliSignIn =
        method === 'browser' &&
        !this.deps.backend.hasEnvironmentKey() &&
        isCliSignedIn(await this.deps.backend.cliSignIn(true)) &&
        (await this.deps.credentials.getApiKey()) === undefined
      if (epoch !== this.signOutEpoch) {
        return this.snapshot
      }
      if (!canRecoverCliSignIn) {
        const refreshed = await this.refresh(true)
        if (epoch !== this.signOutEpoch) {
          return this.snapshot
        }
        if (refreshed.status === 'error') {
          return refreshed
        }
      }
    }
    this.deps.log.info(`Sign-in started: ${method}`)
    if (method === 'apiKey') {
      const key = await this.deps.promptForApiKey()
      if (key === undefined) {
        this.deps.log.info('Sign-in with an API key cancelled')
        return this.snapshot
      }
      if (epoch !== this.signOutEpoch) {
        return this.snapshot
      }
      const activation = this.activateApiKey(key, epoch)
      this.keyActivations.add(activation)
      try {
        return await activation
      } finally {
        this.keyActivations.delete(activation)
      }
    }
    return await this.joinDeviceSignIn()
  }

  public async signOut(): Promise<AuthSnapshot> {
    const running = this.signOutPromise ?? this.performSignOut()
    this.signOutPromise = running
    try {
      return await running
    } finally {
      if (this.signOutPromise === running) {
        this.signOutPromise = undefined
      }
    }
  }

  /** The backend answered a turn with `authRequired`: the estimate was wrong. */
  public markAuthRequired(reason: string): AuthSnapshot {
    this.deps.log.warn(`The backend reported authRequired: ${reason}`)
    return this.set({ ...this.snapshot, status: 'signedOut', detail: reason })
  }

  public markBackendError(detail: string): AuthSnapshot {
    return this.set({ ...this.snapshot, status: 'error', detail })
  }
}
