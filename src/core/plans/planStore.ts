// The workspace's saved plans (M79, PLAN.md D49): `.agents/plans/*.md`.
// A save always makes a new file and never replaces one; every path is
// confined to the workspace, links and junctions resolved (PLAN.md D24), and
// the plans folder must be the workspace's own `.agents/plans`, not a link
// to somewhere else inside it. Reads are bounded. The file system is a port.

import {
  PLAN_FILE_MAX_BYTES,
  PLAN_LIST_MAX,
  PLAN_NAME_ATTEMPTS,
  PLANS_DIR_SEGMENTS,
  UI_TEXT,
} from '../../shared/constants'
import { confineWorkspacePath, type RealPathIo } from '../workspacePath'
import {
  isPlanFileName,
  type PlanContent,
  type PlanDocument,
  parsePlanFile,
  planFileName,
  planSlug,
} from './planDocument'

export interface PlanDirectoryEntry {
  readonly name: string
  /** A link or junction is `other`: never followed. */
  readonly kind: 'file' | 'directory' | 'other'
}

export interface PlanIo extends RealPathIo {
  /**
   * Publishes a new file with `content`, its folder created; false when a
   * file of that name exists already, which is left as it was.
   */
  createFile(absolutePath: string, content: string): Promise<boolean>
  /**
   * The file's bytes, read only from `expectedCanonicalPath`'s target;
   * `bytes` is undefined when it is missing or larger than `maxBytes`.
   */
  readFile(
    absolutePath: string,
    maxBytes: number,
    expectedCanonicalPath: string,
  ): Promise<{ readonly bytes: Uint8Array | undefined; readonly isPdf: boolean }>
  /** A folder's entries; none when it does not exist. */
  listEntries(absolutePath: string): Promise<readonly PlanDirectoryEntry[]>
}

export interface PlanStoreDeps {
  readonly workspaceRoot: string
  readonly platform: NodeJS.Platform
  readonly io: PlanIo
}

/** Where a saved plan landed. */
export interface SavedPlan {
  readonly fileName: string
  /** Workspace-relative, forward slashes: `.agents/plans/<file>`. */
  readonly relativePath: string
}

/** A plan read back whole. */
export interface PlanFile extends SavedPlan {
  readonly bytes: Uint8Array
  readonly document: PlanDocument
}

/** One row of Plans…. */
export interface PlanSummary extends SavedPlan {
  readonly title: string
}

const PLANS_DIR = PLANS_DIR_SEGMENTS.join('/')

interface PlanPlace {
  readonly relativePath: string
  /** The target as the file system resolves it: what is written and read. */
  readonly checkedAbsolute: string
}

/** Case folds where the usual file systems fold it (Windows, macOS). */
function isSameRelative(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

export class PlanStore {
  public constructor(private readonly deps: PlanStoreDeps) {}

  /** A path under the plans folder, confined; throws with the reason otherwise. */
  private async place(relativePath: string): Promise<PlanPlace> {
    const resolution = await confineWorkspacePath(
      this.deps.workspaceRoot,
      relativePath,
      this.deps.platform,
      this.deps.io,
    )
    if (!resolution.ok) {
      throw new Error(resolution.reason)
    }
    // `.agents` or `plans` as a link to another folder of the workspace
    // would put the plans where nobody looks for them.
    if (!isSameRelative(resolution.canonical, relativePath, this.deps.platform)) {
      throw new Error(`${PLANS_DIR} leads to ${resolution.canonical} through a link`)
    }
    return { relativePath, checkedAbsolute: resolution.checkedAbsolute }
  }

  private async planPlace(fileName: string): Promise<PlanPlace> {
    if (!isPlanFileName(fileName)) {
      throw new Error(`${fileName} is not a plan file name`)
    }
    return await this.place(`${PLANS_DIR}/${fileName}`)
  }

  /**
   * Writes the plan, byte for byte, to a new file: `<date>-<slug>.md`, or
   * the first free `-<n>` after it.
   */
  public async save(content: PlanContent): Promise<SavedPlan> {
    const slug = planSlug(content.title)
    for (let attempt = 1; attempt <= PLAN_NAME_ATTEMPTS; attempt += 1) {
      const fileName = planFileName(content.savedAt, slug, attempt)
      const place = await this.planPlace(fileName)
      if (await this.deps.io.createFile(place.checkedAbsolute, content.text)) {
        return { fileName, relativePath: place.relativePath }
      }
    }
    throw new Error(UI_TEXT.planNamesTaken)
  }

  /** Whether the plans folder holds this file (a regular file, not a link). */
  public async has(fileName: string): Promise<boolean> {
    const folder = await this.place(PLANS_DIR)
    const entries = await this.deps.io.listEntries(folder.checkedAbsolute)
    return entries.some((entry) => entry.kind === 'file' && entry.name === fileName)
  }

  /** A plan whole, bounded; throws with the reason when it cannot be read as one. */
  public async read(fileName: string): Promise<PlanFile> {
    const place = await this.planPlace(fileName)
    const read = await this.deps.io.readFile(
      place.checkedAbsolute,
      PLAN_FILE_MAX_BYTES,
      place.checkedAbsolute,
    )
    if (read.isPdf) {
      throw new Error(UI_TEXT.textFileInvalid)
    }
    if (read.bytes === undefined) {
      throw new Error(
        (await this.has(fileName)) ? UI_TEXT.textFileTooLarge : UI_TEXT.planFileMissing,
      )
    }
    const text = new TextDecoder('utf-8').decode(read.bytes)
    return {
      fileName,
      relativePath: place.relativePath,
      bytes: read.bytes,
      document: parsePlanFile(text, fileName),
    }
  }

  /** The saved plans, newest name first; one that cannot be read is listed by its name. */
  public async list(): Promise<readonly PlanSummary[]> {
    const folder = await this.place(PLANS_DIR)
    const entries = await this.deps.io.listEntries(folder.checkedAbsolute)
    const names = entries
      .filter((entry) => entry.kind === 'file' && isPlanFileName(entry.name))
      .map((entry) => entry.name)
      .toSorted((left, right) => right.localeCompare(left))
      .slice(0, PLAN_LIST_MAX)
    const summaries: PlanSummary[] = []
    for (const fileName of names) {
      const relativePath = `${PLANS_DIR}/${fileName}`
      let title = fileName
      try {
        const plan = await this.read(fileName)
        title = plan.document.title
      } catch {
        // Listed by its name: opening or implementing it says why it cannot be read.
      }
      summaries.push({ fileName, relativePath, title })
    }
    return summaries
  }
}
