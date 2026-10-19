import type { Stats } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

const IMAGE_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
])
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const cache = new Map<string, { fingerprint: string; data: string; bytes: number }>()
const MAX_CACHE_ENTRIES = 8
const MAX_CACHE_BYTES = 32 * 1024 * 1024

function fingerprint(metadata: Stats) {
  return `${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.ino}`
}

/** Bounded LRU cache; an unchanged image is not reread for opacity-only updates. */
export async function imageFileToDataUrl(imagePath: string) {
  const file = path.resolve(imagePath)
  const mediaType = IMAGE_TYPES.get(path.extname(file).toLowerCase())
  if (!mediaType) throw new Error(`Unsupported image type: ${path.extname(file) || "no extension"}`)
  const metadata = await stat(file)
  if (!metadata.isFile()) throw new Error(`Background image is not a file: ${file}`)
  if (metadata.size > MAX_IMAGE_BYTES)
    throw new Error(`Background image exceeds the 25 MB limit: ${file}`)
  const key = fingerprint(metadata)
  const previous = cache.get(file)
  cache.delete(file)
  if (previous?.fingerprint === key) {
    cache.set(file, previous)
    return previous.data
  }
  const contents = await readFile(file)
  // Recheck after read so growing files cannot bypass the limit or poison the cache.
  if (contents.length > MAX_IMAGE_BYTES)
    throw new Error(`Background image exceeds the 25 MB limit: ${file}`)
  const after = await stat(file)
  const data = `data:${mediaType};base64,${contents.toString("base64")}`
  if (fingerprint(after) !== key) return data
  const bytes = Buffer.byteLength(data)
  let total = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0)
  while (cache.size && (total + bytes > MAX_CACHE_BYTES || cache.size >= MAX_CACHE_ENTRIES)) {
    const oldest = cache.keys().next().value!
    total -= cache.get(oldest)!.bytes
    cache.delete(oldest)
  }
  if (bytes <= MAX_CACHE_BYTES) cache.set(file, { fingerprint: key, data, bytes })
  return data
}

export async function imageRevision(images: string[]) {
  return (
    await Promise.all(images.map(async (image) => `${image}:${fingerprint(await stat(image))}`))
  ).join("|")
}
