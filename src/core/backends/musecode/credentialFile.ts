// What the Muse Code CLI's credential file (`auth.json`) says about its
// sign-in, from the file's structure alone (PLAN.md D26, 2026-09-27). The
// schema keeps three facts: the schema version, which providers are named,
// and whether a provider's `storage` points to the macOS Keychain. Every
// other field, the token included, is dropped by the parse, and nothing from
// the file is stored, logged or passed on.
//
// Shapes seen on Muse Code 1.3.0 and 1.4.0-R4302.1 (isolated homes):
// - `{"schema_version": 1, "providers": {}}`: what `muse logout` and MSP
//   `account/logout` leave behind (they rewrite the file, never delete it).
//   Signed out on every OS.
// - Version 1 with `providers.meta` holding its credential: `muse auth set`
//   writes `api_key` alone, a browser sign-in the token, the key and the
//   account's name. Signed in.
// - Only `providers.meta` speaks for the sign-in: 1.4.0-R4302.1's bundled
//   Slack connector reads its own `providers.slack_connector`, so a file
//   naming other providers alone is left to the CLI.
// - Version 2 with `providers.meta.storage: "keychain"`: macOS keeps the
//   token in the login Keychain and the file is a pointer. On Windows
//   `muse serve` exits 3 at startup with any version-2 file, the empty one
//   included ("unsupported auth schema version 2"), and with a version-1
//   `meta` whose storage is the Keychain.

import * as z from 'zod/mini'
import {
  MACOS_KEYCHAIN_ITEM_NOT_FOUND_EXIT,
  MUSE_CREDENTIAL_INLINE_SCHEMA,
  MUSE_CREDENTIAL_KEYCHAIN_STORAGE,
  MUSE_CREDENTIAL_POINTER_SCHEMA,
  MUSE_CREDENTIAL_PROVIDER,
} from '../../../shared/constants'

/**
 * - `empty`: names no provider; the file a sign-out leaves.
 * - `inline`: holds the credential itself.
 * - `keychain`: points to the macOS Keychain (on macOS).
 * - `unsupportedHere`: a macOS file on Windows or Linux (version 2, or the
 *   Keychain lane), where `muse serve` cannot start with it.
 * - `unrecognized`: anything else; only the CLI can say.
 */
export type CredentialFileVerdict =
  'empty' | 'inline' | 'keychain' | 'unsupportedHere' | 'unrecognized'

/**
 * The CLI's own sign-in as the extension sees it: `unknown` when only the
 * CLI could say and it has not (the estimate counts it as signed in, and a
 * turn's `authRequired` corrects it); `unsupportedHere` when the file stops
 * `muse serve` from starting.
 */
export type CliSignIn = 'signedIn' | 'signedOut' | 'unknown' | 'unsupportedHere'

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
  if (version !== MUSE_CREDENTIAL_INLINE_SCHEMA && version !== MUSE_CREDENTIAL_POINTER_SCHEMA) {
    return 'unrecognized'
  }
  const isMacOs = platform === 'darwin'
  // Off macOS the version alone stops `muse serve`, whatever the file holds
  // (captured on Windows for a pointer and for an empty file; the review of
  // PR #49).
  if (version === MUSE_CREDENTIAL_POINTER_SCHEMA && !isMacOs) {
    return 'unsupportedHere'
  }
  const providers = parsed.data.providers
  const muse = Object.hasOwn(providers, MUSE_CREDENTIAL_PROVIDER)
    ? providers[MUSE_CREDENTIAL_PROVIDER]
    : undefined
  if (muse === undefined) {
    // No provider at all is signed out; another provider alone (a
    // connector's token) says nothing about the sign-in.
    return Object.keys(providers).length === 0 ? 'empty' : 'unrecognized'
  }
  if (
    version === MUSE_CREDENTIAL_POINTER_SCHEMA ||
    muse.storage === MUSE_CREDENTIAL_KEYCHAIN_STORAGE
  ) {
    return isMacOs ? 'keychain' : 'unsupportedHere'
  }
  return 'inline'
}

/** `security find-generic-password` without `-g`/`-w`: 0 found, 44 not found. */
export function keychainItemPresence(exitCode: number): KeychainItemPresence {
  if (exitCode === 0) {
    return 'present'
  }
  return exitCode === MACOS_KEYCHAIN_ITEM_NOT_FOUND_EXIT ? 'absent' : 'unknown'
}
