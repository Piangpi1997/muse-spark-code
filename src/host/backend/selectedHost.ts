// Admission for the extension's host selector. Raw credential presence may
// choose a backend, but never grants a host after sign-out or an auth change.

import type { BackendKind } from '../../core/agent/agentBackend'
import type { BackendChoice } from '../../core/backendSelection'
import { UI_TEXT } from '../../shared/constants'

export async function chooseAuthorizedHost<T>(
  admittedBackend: () => BackendKind | undefined,
  readRawChoice: () => Promise<BackendChoice>,
  openHost: (kind: BackendKind) => Promise<T>,
  admissionGeneration: () => number,
): Promise<T> {
  const before = admittedBackend()
  if (before === undefined) {
    throw new Error(UI_TEXT.sendDisabledReason)
  }
  const generation = admissionGeneration()
  const choice = await readRawChoice()
  if (
    admissionGeneration() !== generation ||
    admittedBackend() !== before ||
    choice.kind !== before ||
    choice.status !== 'signedIn'
  ) {
    throw new Error(UI_TEXT.sendDisabledReason)
  }
  const host = await openHost(before)
  if (admissionGeneration() !== generation || admittedBackend() !== before) {
    // ensureHost returns a manager-owned cache entry. The manager stops it on
    // a real backend shutdown; a secondary key change must leave CLI chat up.
    throw new Error(UI_TEXT.sendDisabledReason)
  }
  return host
}
