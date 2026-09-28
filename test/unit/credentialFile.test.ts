import { describe, expect, it } from 'vitest'
import {
  credentialFileVerdict,
  keychainItemPresence,
} from '../../src/core/backends/musecode/credentialFile'
import {
  AUTH_SET_FILE,
  DEVICE_LOGIN_FILE,
  LOGOUT_SHELL,
  SLACK_CONNECTOR_ONLY,
} from './helpers/credentialShapes'

// Not captured here: the macOS pointer a third party observed on 1.3.0
// (aonia §2.3); the probes of 2026-09-27 wrote the same shape to see what
// `muse serve` does with it.
const MAC_POINTER = JSON.stringify({
  schema_version: 2,
  providers: {
    meta: {
      mechanism: 'oauth',
      storage: 'keychain',
      obtained_via: 'device_code',
      api_base_url: 'https://api.meta.ai/v1',
    },
  },
})
// Synthetic, as the probe of 2026-09-27 wrote it: a version-1 `meta` whose
// storage is the Keychain (`muse serve` exits 3 with it on Windows).
const SCHEMA_1_POINTER = JSON.stringify({
  schema_version: 1,
  providers: { meta: { storage: 'keychain' } },
})
// Synthetic: the empty version-2 file the probe of 2026-09-27 gave `muse
// serve`, which exits 3 with it on Windows.
const EMPTY_V2 = '{"schema_version":2,"providers":{}}'

/** Synthetic: `meta` beside a connector whose own entry uses the Keychain. */
function besideConnector(meta: Record<string, string>): string {
  return JSON.stringify({
    schema_version: 1,
    providers: { slack_connector: { storage: 'keychain' }, meta },
  })
}

describe('credentialFileVerdict', () => {
  it.each(['win32', 'linux', 'darwin'] as const)(
    'reads the file a sign-out leaves as empty on %s',
    (platform) => {
      expect(credentialFileVerdict(LOGOUT_SHELL, platform)).toBe('empty')
    },
  )

  it('reads a stored key or login as held in the file', () => {
    expect(credentialFileVerdict(AUTH_SET_FILE, 'win32')).toBe('inline')
    expect(credentialFileVerdict(DEVICE_LOGIN_FILE, 'win32')).toBe('inline')
    expect(credentialFileVerdict(DEVICE_LOGIN_FILE, 'linux')).toBe('inline')
    expect(credentialFileVerdict(DEVICE_LOGIN_FILE, 'darwin')).toBe('inline')
  })

  it('reads a macOS Keychain pointer as needing the CLI on macOS', () => {
    expect(credentialFileVerdict(MAC_POINTER, 'darwin')).toBe('keychain')
    expect(credentialFileVerdict(SCHEMA_1_POINTER, 'darwin')).toBe('keychain')
    expect(credentialFileVerdict(EMPTY_V2, 'darwin')).toBe('empty')
  })

  // Each made `muse serve` exit 3 on Windows 1.4.0 (isolated homes), the
  // empty version-2 file included: "unsupported auth schema version 2" (the
  // review of PR #49).
  it.each(['win32', 'linux'] as const)(
    'names a macOS file Muse Code cannot start with on %s',
    (platform) => {
      expect(credentialFileVerdict(MAC_POINTER, platform)).toBe('unsupportedHere')
      expect(credentialFileVerdict(SCHEMA_1_POINTER, platform)).toBe('unsupportedHere')
      expect(credentialFileVerdict(EMPTY_V2, platform)).toBe('unsupportedHere')
    },
  )

  // Only `meta` speaks for the sign-in (the review of PR #49).
  it.each(['win32', 'linux', 'darwin'] as const)(
    'leaves a file naming another provider alone to the CLI on %s',
    (platform) => {
      expect(credentialFileVerdict(SLACK_CONNECTOR_ONLY, platform)).toBe('unrecognized')
    },
  )

  it('decides on meta beside another provider, and on meta’s storage only', () => {
    expect(credentialFileVerdict(besideConnector({ api_key: '<placeholder>' }), 'win32')).toBe(
      'inline',
    )
    expect(credentialFileVerdict(besideConnector({ storage: 'keychain' }), 'win32')).toBe(
      'unsupportedHere',
    )
  })

  it.each([
    ['not JSON', '{"schema_version": 1, "providers": '],
    ['a future schema', '{"schema_version": 3, "providers": {"meta": {}}}'],
    ['no providers', '{"schema_version": 1}'],
    ['a provider that is not an object', '{"schema_version": 1, "providers": {"meta": "x"}}'],
    ['a version that is not a number', '{"schema_version": "1", "providers": {}}'],
    ['an array', '[]'],
  ])('leaves %s to the CLI', (_name, text) => {
    expect(credentialFileVerdict(text, 'linux')).toBe('unrecognized')
  })
})

describe('keychainItemPresence', () => {
  it('reads the attribute lookup’s exit code', () => {
    expect(keychainItemPresence(0)).toBe('present')
    expect(keychainItemPresence(44)).toBe('absent')
    expect(keychainItemPresence(-1)).toBe('unknown')
    expect(keychainItemPresence(36)).toBe('unknown')
  })
})
