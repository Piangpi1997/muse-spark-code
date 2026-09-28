// "Allow always in this workspace" for the agent's paid uses (M58, PLAN.md
// D48, D62), kept in the agent's data folder beside its sessions: one JSON
// file mapping each folder's key (dataFolder.ts, a hash of its path) to the
// features allowed always there. Feature names only, no content. The file is
// read at every question, so a grant another agent process made or dropped
// counts at once, and replaced whole (host/fsAtomic.ts), so a reader never
// sees half of it; this process writes one change at a time. A file that
// cannot be read or parsed counts as no grants, so the question is asked
// again rather than skipped.

import { readFileSync } from 'node:fs'
import * as z from 'zod/mini'
import type { PaidGrantStore } from '../acp/paid'
import type { CoreLogger } from '../core/logging'
import { describeStoreError, storeErrorCode } from '../host/backend/storeErrors'
import { writeFileAtomically } from '../host/fsAtomic'
import { PAID_FEATURES, type PaidFeature } from '../shared/constants'
import { workspaceKey } from './dataFolder'

export interface PaidGrantFileDeps {
  readonly file: string
  readonly log: CoreLogger
  /** Waits between rename attempts (fsAtomic); injectable so tests do not sleep. */
  readonly sleep: (ms: number) => Promise<void>
}

const ENOENT = 'ENOENT'
// Folder key → feature names; a name that is not a paid feature is dropped.
const grantsSchema = z.record(z.string(), z.array(z.string()))

type Grants = Map<string, ReadonlySet<PaidFeature>>

function isPaidFeature(name: string): name is PaidFeature {
  const features: readonly string[] = PAID_FEATURES
  return features.includes(name)
}

export function paidGrantFile(deps: PaidGrantFileDeps): PaidGrantStore {
  let writing: Promise<void> = Promise.resolve()

  const readAll = (): Grants => {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(deps.file, 'utf8'))
    } catch (error: unknown) {
      if (storeErrorCode(error) !== ENOENT) {
        deps.log.warn(`Paid-use grants in ${deps.file} ignored: ${describeStoreError(error)}`)
      }
      return new Map()
    }
    const parsed = grantsSchema.safeParse(raw)
    if (!parsed.success) {
      deps.log.warn(`Paid-use grants in ${deps.file} ignored: not a map of folders to features`)
      return new Map()
    }
    return new Map(
      Object.entries(parsed.data).map(([key, names]) => [
        key,
        new Set(names.filter(isPaidFeature)),
      ]),
    )
  }

  const writeAll = async (grants: Grants): Promise<void> => {
    const kept = [...grants].filter(([, features]) => features.size > 0)
    const content = Object.fromEntries(kept.map(([key, features]) => [key, [...features]]))
    await writeFileAtomically(deps.file, `${JSON.stringify(content, undefined, 2)}\n`, {
      sleep: deps.sleep,
    })
  }

  /** Applies `hasChanged` to the file as it is once `previous` is done; writes what changed. */
  const apply = async (
    previous: Promise<void>,
    hasChanged: (grants: Grants) => boolean,
  ): Promise<void> => {
    try {
      await previous
    } catch {
      // That change already failed its own caller; this one starts afresh.
    }
    const grants = readAll()
    if (hasChanged(grants)) {
      await writeAll(grants)
    }
  }

  /** One change at a time in this process, each on the file as it is then. */
  const change = (hasChanged: (grants: Grants) => boolean): Promise<void> => {
    writing = apply(writing, hasChanged)
    return writing
  }

  return {
    read: (workspaceRoot) => readAll().get(workspaceKey(workspaceRoot)) ?? new Set(),
    write: (workspaceRoot, features) =>
      change((grants) => {
        grants.set(workspaceKey(workspaceRoot), new Set(features))
        return true
      }),
    forget: (features) =>
      change((grants) => {
        let isChanged = false
        for (const [key, granted] of grants) {
          const kept = [...granted].filter((feature) => !features.includes(feature))
          if (kept.length === granted.size) {
            continue
          }
          grants.set(key, new Set(kept))
          isChanged = true
        }
        return isChanged
      }),
  }
}
