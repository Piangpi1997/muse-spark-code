// dist/modelApi.js as the production build makes it (M57, PLAN.md D6): the
// entry bundled by esbuild into a folder the test owns, in the build's
// format, platform and target, for tests that load the Model API backend the
// way the extension does, with Node's own `require`.

import path from 'node:path'
import { buildSync } from 'esbuild'
import { MODEL_API_BUNDLE_FILE } from '../../../src/shared/constants'

/** Builds the bundle into `folder` and returns its path. */
export function buildModelApiBundle(folder: string): string {
  const file = path.join(folder, MODEL_API_BUNDLE_FILE)
  buildSync({
    entryPoints: [path.resolve('src/host/backend/modelApiEntry.ts')],
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  })
  return file
}
