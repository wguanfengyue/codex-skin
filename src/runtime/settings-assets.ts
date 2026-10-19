import { copyFile, chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import type { IncomingMessage } from "node:http"
import path from "node:path"

import type { CodexSkinCore } from "../core/index.ts"
import type { BundledBackgroundOption, BundledBackgroundCatalog } from "../shared/protocol.ts"
import { readConfig, writeConfig, resolveDataDirectory } from "./config.ts"
import { imageFileToDataUrl } from "./css.ts"
import { readBody } from "./settings-http.ts"
import { BACKGROUND_SURFACES, errorCode } from "./types.ts"
import type { BackgroundConfig, BackgroundImageTarget, DataDirectoryOptions } from "./types.ts"
interface AssetOptions extends DataDirectoryOptions {
  backgroundsRoot?: string
  core: CodexSkinCore
}
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
export const IMAGE_EXTENSIONS = new Map([
  ["image/avif", ".avif"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
])
const BUNDLED_BACKGROUND_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"])
const BACKGROUND_IMAGE_TARGETS = ["wallpaper", ...BACKGROUND_SURFACES] as const

function configuredImage(config: BackgroundConfig, target: BackgroundImageTarget) {
  return target === "wallpaper" ? config.wallpaper.image : config.surfaces[target].image
}

function bundledBackgroundDestinationName(target: BackgroundImageTarget, file: string) {
  return `builtin-${target}-${file}`
}

function bundledBackgroundLabel(file: string) {
  return path.basename(file, path.extname(file)).replace(/[-_]+/g, " ").trim()
}

/** Reads supported image files directly from one bundled background directory. */
async function bundledBackgroundItems(
  target: BackgroundImageTarget,
  options: AssetOptions,
): Promise<BundledBackgroundOption[]> {
  const directory = path.join(options.backgroundsRoot || "", target)
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          BUNDLED_BACKGROUND_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
      )
      .map((entry) => ({
        file: entry.name,
        label: bundledBackgroundLabel(entry.name),
        url: `/backgrounds/${target}/${encodeURIComponent(entry.name)}`,
      }))
      .sort((first, second) =>
        first.label.localeCompare(second.label, "zh-CN", { numeric: true, sensitivity: "base" }),
      )
  } catch (error) {
    if (errorCode(error) === "ENOENT") return []
    throw error
  }
}

/** Builds the current per-module selector options without requiring a separate manifest. */
export async function bundledBackgroundCatalog(
  config: BackgroundConfig,
  options: AssetOptions,
): Promise<BundledBackgroundCatalog> {
  const groups = await Promise.all(
    BACKGROUND_IMAGE_TARGETS.map(async (target) => {
      const items = await bundledBackgroundItems(target, options)
      const currentName = path.basename(configuredImage(config, target) || "")
      const selected =
        items.find((item) => bundledBackgroundDestinationName(target, item.file) === currentName)
          ?.file || null
      return [target, { items, selected }] as const
    }),
  )
  return Object.fromEntries(groups) as BundledBackgroundCatalog
}

function imageIsStillReferenced(config: BackgroundConfig, image: string | null) {
  return (
    config.wallpaper.image === image ||
    BACKGROUND_SURFACES.some((candidate) => config.surfaces[candidate].image === image)
  )
}

async function removeUnusedManagedImage(
  image: string | null,
  replacement: string,
  config: BackgroundConfig,
  imageDirectory: string,
) {
  if (
    image?.startsWith(`${imageDirectory}${path.sep}`) &&
    image !== replacement &&
    !imageIsStillReferenced(config, image)
  ) {
    await rm(image, { force: true })
  }
}

export async function selectBundledBackground(
  input: unknown,
  target: BackgroundImageTarget,
  options: AssetOptions,
) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {}
  const requestedFile = "file" in source && typeof source.file === "string" ? source.file : ""
  const item = (await bundledBackgroundItems(target, options)).find(
    (candidate) => candidate.file === requestedFile,
  )
  if (!item) throw new Error("The selected bundled background does not exist.")

  const sourcePath = path.join(options.backgroundsRoot || "", target, item.file)
  await imageFileToDataUrl(sourcePath)
  const imageDirectory = path.join(options.dataDirectory || resolveDataDirectory(), "images")
  await mkdir(imageDirectory, { recursive: true, mode: 0o700 })
  const destination = path.join(imageDirectory, bundledBackgroundDestinationName(target, item.file))
  const extension = path.extname(item.file).toLowerCase()
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp${extension}`
  await copyFile(sourcePath, temporary)
  try {
    await chmod(temporary, 0o600)
    await imageFileToDataUrl(temporary)
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }

  const previous = await readConfig({ dataDirectory: options.dataDirectory })
  const previousImage = configuredImage(previous, target)
  const config = await writeConfig(
    target === "wallpaper"
      ? { ...previous, wallpaper: { ...previous.wallpaper, enabled: true, image: destination } }
      : {
          ...previous,
          surfaces: {
            ...previous.surfaces,
            [target]: { ...previous.surfaces[target], enabled: true, image: destination },
          },
        },
    { dataDirectory: options.dataDirectory },
  )
  await removeUnusedManagedImage(previousImage, destination, config, imageDirectory)
  const application = await options.core.sync(config)
  return { config, application }
}

export async function uploadImage(
  request: IncomingMessage,
  imageTarget: BackgroundImageTarget,
  options: AssetOptions,
) {
  const mediaType = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    ?.toLowerCase()
  const extension = mediaType ? IMAGE_EXTENSIONS.get(mediaType) : undefined
  if (!extension) throw new Error("Choose a PNG, JPEG, WebP, GIF, or AVIF image.")
  const contents = await readBody(request, MAX_IMAGE_BYTES)
  if (contents.length === 0) throw new Error("The selected image is empty.")

  const imageDirectory = path.join(options.dataDirectory || resolveDataDirectory(), "images")
  await mkdir(imageDirectory, { recursive: true, mode: 0o700 })
  const now = Date.now()
  const target = path.join(imageDirectory, `background-${imageTarget}-${now}${extension}`)
  const temporary = `${target}.${process.pid}.tmp${extension}`
  await writeFile(temporary, contents, { mode: 0o600 })
  try {
    await imageFileToDataUrl(temporary)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }

  const previous = await readConfig({ dataDirectory: options.dataDirectory })
  const previousImage =
    imageTarget === "wallpaper" ? previous.wallpaper.image : previous.surfaces[imageTarget].image
  const config = await writeConfig(
    imageTarget === "wallpaper"
      ? { ...previous, wallpaper: { ...previous.wallpaper, enabled: true, image: target } }
      : {
          ...previous,
          surfaces: {
            ...previous.surfaces,
            [imageTarget]: {
              ...previous.surfaces[imageTarget],
              enabled: true,
              image: target,
            },
          },
        },
    { dataDirectory: options.dataDirectory },
  )
  await removeUnusedManagedImage(previousImage, target, config, imageDirectory)
  const application = await options.core.sync(config)
  return { config, application }
}
