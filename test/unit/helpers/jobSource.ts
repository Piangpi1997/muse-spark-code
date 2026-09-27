// The shipped C# of the Windows job helpers (PLAN.md D6), as the tests hand
// it to the helpers: read from the repository, where the extension reads it
// from its own folder.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JOB_SOURCE_FILE, jobSourceReader } from '../../../src/host/backend/jobSource'

const REPOSITORY = process.cwd()

export const readJobSource = jobSourceReader(REPOSITORY)

export const JOB_SOURCE = readFileSync(path.join(REPOSITORY, JOB_SOURCE_FILE), 'utf8')
