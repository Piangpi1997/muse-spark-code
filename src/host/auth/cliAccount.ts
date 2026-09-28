// The Muse Code CLI's own sign-in, as the extension tells it (PLAN.md D26,
// 2026-09-27). `muse logout` rewrites the credential file instead of
// deleting it, so the file being there says nothing on its own:
// - No file: signed out on every OS, and no process is started.
// - A file is read for its structure only (credentialFile.ts); a sign-out's
//   empty file is signed out and a file holding the credential signed in.
// - A macOS Keychain pointer or a file the structure cannot place is asked
//   of the CLI itself (`account/read` on a short-lived host), and that answer
//   is kept until the file's size or modification time changes.
// - On macOS the question waits for a user action (a click in the panel), so
//   a Keychain prompt never appears just because VS Code opened.

import { readFileSync, statSync } from 'node:fs'
import {
  type CliSignIn,
  type CredentialFileVerdict,
  credentialFileVerdict,
} from '../../core/backends/musecode/credentialFile'
import { MUSE_ACCOUNT_STATES, MUSE_CREDENTIAL_FILE_MAX_BYTES } from '../../shared/constants'
import type { Logger } from '../logger'
import { type AccountState, isStoredSignIn } from './accountHost'

export interface CredentialFileReading {
  /** `<size>:<mtime>`: a write changes it. */
  readonly signature: string
  readonly verdict: CredentialFileVerdict
}

// A path that is not there, as opposed to one that is there and unreadable.
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])
const UNREADABLE_SIGNATURE = 'unreadable'

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : ''
}

/** The credential file's structure, or undefined when there is no file. Never a value from it. */
export function readCredentialFile(
  filePath: string,
  platform: NodeJS.Platform,
): CredentialFileReading | undefined {
  let size: number
  let modifiedAt: number
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) {
      return { signature: UNREADABLE_SIGNATURE, verdict: 'unrecognized' }
    }
    size = stats.size
    modifiedAt = stats.mtimeMs
  } catch (error: unknown) {
    return MISSING_CODES.has(errorCode(error))
      ? undefined
      : { signature: UNREADABLE_SIGNATURE, verdict: 'unrecognized' }
  }
  const signature = `${String(size)}:${String(modifiedAt)}`
  if (size > MUSE_CREDENTIAL_FILE_MAX_BYTES) {
    return { signature, verdict: 'unrecognized' }
  }
  try {
    return { signature, verdict: credentialFileVerdict(readFileSync(filePath, 'utf8'), platform) }
  } catch {
    return { signature, verdict: 'unrecognized' }
  }
}

/** What `account/read` says about the stored sign-in; undefined when it said nothing. */
export function cliSignInFromAccount(account: AccountState | undefined): CliSignIn {
  if (account === undefined) {
    return 'unknown'
  }
  // A keyless gateway needs no credential (the schema's `credentialRequired`).
  if (!account.credentialRequired || isStoredSignIn(account)) {
    return 'signedIn'
  }
  // `envKey` masks the stored lane, and a future state is not guessed at.
  return account.state === MUSE_ACCOUNT_STATES.loggedOut ? 'signedOut' : 'unknown'
}

/** What the structure settles alone; a Keychain pointer on macOS and anything unrecognized go to the CLI. */
const FILE_SIGN_IN: Partial<Record<CredentialFileVerdict, CliSignIn>> = {
  empty: 'signedOut',
  inline: 'signedIn',
  keychainElsewhere: 'keychainElsewhere',
}

/** Signed in, or possibly: the estimate the gate and the backend choice use. */
export function isCliSignedIn(signIn: CliSignIn): boolean {
  return signIn === 'signedIn' || signIn === 'unknown'
}

export interface CliAccountDeps {
  readonly platform: NodeJS.Platform
  readonly credentialFilePath: () => string
  /** `account/read` on a short-lived host; undefined when it could not say. */
  readonly probe: () => Promise<AccountState | undefined>
  readonly log: Logger
}

export class CliAccount {
  private answered: { readonly key: string; readonly signIn: CliSignIn } | undefined
  private asking: { readonly key: string; readonly signIn: Promise<CliSignIn> } | undefined

  public constructor(private readonly deps: CliAccountDeps) {}

  private async confirm(key: string, isUserAction: boolean): Promise<CliSignIn> {
    const answered = this.answered
    // A remembered "could not say" is asked again when the user acts.
    if (answered?.key === key && (!isUserAction || answered.signIn !== 'unknown')) {
      return answered.signIn
    }
    if (!isUserAction && this.deps.platform === 'darwin') {
      return 'unknown'
    }
    if (this.asking?.key === key) {
      return await this.asking.signIn
    }
    const asking = { key, signIn: this.ask() }
    this.asking = asking
    try {
      const signIn = await asking.signIn
      // An abandoned probe's late answer is not remembered.
      if (this.asking === asking) {
        this.answered = { key, signIn }
      }
      return signIn
    } finally {
      if (this.asking === asking) {
        this.asking = undefined
      }
    }
  }

  private async ask(): Promise<CliSignIn> {
    const account = await this.deps.probe()
    const signIn = cliSignInFromAccount(account)
    // The state word only: the account's label is an e-mail address.
    this.deps.log.info(
      `Muse Code sign-in confirmed by account/read: ${account?.state ?? 'no answer'} (${signIn})`,
    )
    return signIn
  }

  /**
   * Leaves an unanswered probe behind (Cancel, sign-out; the review of PR
   * #49): later questions start a fresh one instead of waiting on it.
   */
  public abandonAsking(): void {
    this.asking = undefined
  }

  /**
   * The CLI's sign-in. `isUserAction` lets macOS ask the CLI (the host may
   * read the Keychain); elsewhere an ambiguous file is asked about at once.
   */
  public async signIn(isUserAction: boolean): Promise<CliSignIn> {
    const filePath = this.deps.credentialFilePath()
    const reading = readCredentialFile(filePath, this.deps.platform)
    return reading === undefined
      ? 'signedOut'
      : (FILE_SIGN_IN[reading.verdict] ??
          (await this.confirm(`${filePath}\n${reading.signature}`, isUserAction)))
  }
}
