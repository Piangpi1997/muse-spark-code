// The VS Code side of plans as files (M79, PLAN.md D49): the plan store over
// the file system, and the Plans… picks. The flow lives in
// commands/planCommands.ts, the files in core/plans/planStore.ts, and what a
// plan does in the conversation in conversation/conversationController.ts.

import { type PlanIo, PlanStore } from '../core/plans/planStore'
import { PLAN_FILE_MODE, UI_TEXT } from '../shared/constants'
import { listMemoryEntries } from './backend/memoryIo'
import { readPickedFile } from './backend/toolIo'
import { canonicalPath } from './canonicalPath'
import { choosePlan } from './commands/planCommands'
import type { PickOne } from './commands/pickItem'
import type { PlanFiles } from './conversation/conversationController'
import { createFileExclusively } from './fsAtomic'
import type { Logger } from './logger'

// What the hard link answers when the plan's name is taken.
const NAME_TAKEN = 'EEXIST'

function isNameTaken(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === NAME_TAKEN
}

/** The plan store's file access: no-clobber creation, bounded checked reads, entries by kind. */
export function createPlanIo(
  log: Logger,
  publish?: (stage: string, target: string) => Promise<void>,
): PlanIo {
  return {
    realPath: canonicalPath,
    async createFile(absolutePath, content) {
      try {
        await createFileExclusively(absolutePath, content, {
          mode: PLAN_FILE_MODE,
          warn: (message) => {
            log.warn(`Plan ${message}`)
          },
          ...(publish !== undefined && { publish }),
        })
        return true
      } catch (error: unknown) {
        if (isNameTaken(error)) {
          return false
        }
        throw error
      }
    },
    readFile: (absolutePath, maxBytes, expectedCanonicalPath) =>
      readPickedFile(absolutePath, maxBytes, expectedCanonicalPath),
    listEntries: listMemoryEntries,
  }
}

export interface PlanFeatureDeps {
  readonly workspaceRoot: string
  readonly platform: NodeJS.Platform
  /** `createPlanIo` over the file system. */
  readonly io: PlanIo
  readonly pick: PickOne
  /** A modal; true when the user chose `action`. */
  readonly confirm: (message: string, detail: string, action: string) => Promise<boolean>
}

export function createPlanFiles(deps: PlanFeatureDeps): PlanFiles {
  const store = new PlanStore({
    workspaceRoot: deps.workspaceRoot,
    platform: deps.platform,
    io: deps.io,
  })
  return {
    save: (content) => store.save(content),
    has: (fileName) => store.has(fileName),
    read: (fileName) => store.read(fileName),
    list: () => store.list(),
    confirmSave: () =>
      deps.confirm(UI_TEXT.planSaveConfirm, UI_TEXT.planSaveConfirmDetail, UI_TEXT.savePlan),
    choose: (plans) => choosePlan(plans, deps.pick),
  }
}
