// What the Muse Code CLI's credential file (`auth.json`) says about its
// sign-in, from the file's structure alone (PLAN.md D26, 2026-09-27). The
// schema keeps three facts: the schema version, whether any provider is
// named, and whether a provider's `storage` points to the macOS Keychain.
// Every other field, the token included, is dropped by the parse, and
// nothing from the file is stored, logged or passed on.
//
// Shapes seen on Muse Code 1.3.0 and 1.4.0-R4302.1 (isolated homes):
// - `{"schema_version": 1, "providers": {}}`: what `muse logout` and MSP
//   `account/logout` leave behind (they rewrite the file, never delete it).
//   Signed out on every OS.
// - Version 1 with a provider holding its credential: signed in.
// - Version 2 with `providers.meta.storage: "keychain"`: macOS keeps the
//   token in the login Keychain and the file is a pointer. On Windows and
//   Linux `muse serve` exits 3 at startup with that file, and with a
//   version-1 provider whose storage is the Keychain.

import * as z from 'zod/mini'
import {
  MACOS_KEYCHAIN_ITEM_NOT_FOUND_EXIT,
  MUSE_CREDENTIAL_INLINE_SCHEMA,
  MUSE_CREDENTIAL_KEYCHAIN_STORAGE,
  MUSE_CREDENTIAL_POINTER_SCHEMA,
} from '../../../shared/constants'

/**
 * - `empty`: names no provider; the file a sign-out leaves.
 * - `inline`: holds the credential itself.
 * - `keychain`: points to the macOS Keychain (on macOS).
 * - `keychainElsewhere`: a macOS pointer on Windows or Linux, where `muse
 *   serve` cannot start with it.
 * - `unrecognized`: anything else; only the CLI can say.
 */
export type CredentialFileVerdict =
  'empty' | 'inline' | 'keychain' | 'keychainElsewhere' | 'unrecognized'

/**
 * The CLI's own sign-in as the extension sees it: `unknown` when only the
 * CLI could say and it has not (the estimate counts it as signed in, and a
 * turn's `authRequired` corrects it); `keychainElsewhere` when the file
 * stops `muse serve` from starting.
 */
export type CliSignIn = 'signedIn' | 'signedOut' | 'unknown' | 'keychainElsewhere'

/** Whether the macOS Keychain holds the CLI's item, by attribute lookup only. */
export type KeychainItemPresence = 'present' | 'absent' | 'unknown'

// Unknown keys are dropped by the parse: a provider keeps its storage lane,
// never its key or tokens.
const credentialFileSchema = z.object({
  schema_version: z.number(),
  providers: z.record(z.string(), z.object({ storage: z.optional(z.string()) })),
})

export function credentialFileVerdict(
  text: string,
  platform: NodeJS.Platform,
): CredentialFileVerdict {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return 'unrecognized'
  }
  const parsed = credentialFileSchema.safeParse(raw)
  if (!parsed.success) {
    return 'unrecognized'
  }
  const version = parsed.data.schema_version
  const providers = Object.values(parsed.data.providers)
  const isKeychainStyle =
    version === MUSE_CREDENTIAL_POINTER_SCHEMA ||
    providers.some((provider) => provider.storage === MUSE_CREDENTIAL_KEYCHAIN_STORAGE)
  if (isKeychainStyle && platform !== 'darwin') {
    return 'keychainElsewhere'
  }
  if (isKeychainStyle) {
    return providers.length === 0 ? 'empty' : 'keychain'
  }
  if (version !== MUSE_CREDENTIAL_INLINE_SCHEMA) {
    return 'unrecognized'
  }
  return providers.length === 0 ? 'empty' : 'inline'
}

/** `security find-generic-password` without `-g`/`-w`: 0 found, 44 not found. */
export function keychainItemPresence(exitCode: number): KeychainItemPresence {
  if (exitCode === 0) {
    return 'present'
  }
  return exitCode === MACOS_KEYCHAIN_ITEM_NOT_FOUND_EXIT ? 'absent' : 'unknown'
}
