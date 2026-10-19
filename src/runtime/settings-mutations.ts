import path from "node:path"

import { resolveDataDirectory } from "./config.ts"
import type { DataDirectoryOptions } from "./types.ts"

const pending = new Map<string, Promise<unknown>>()

/** Serialize read/merge/write/apply across all HTTP mutation routes for one data directory. */
export function mutateSettings<Result>(
  options: DataDirectoryOptions,
  operation: () => Promise<Result>,
) {
  const key = path.resolve(options.dataDirectory || resolveDataDirectory(options.env))
  const result = (pending.get(key) || Promise.resolve()).catch(() => undefined).then(operation)
  pending.set(key, result)
  return result.finally(() => {
    if (pending.get(key) === result) pending.delete(key)
  })
}
