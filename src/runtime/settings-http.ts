import { readFile, stat } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"

import { BackgroundStateError } from "./background-service.ts"
import { errorCode } from "./types.ts"
export const COOKIE_NAME = "codex_skin_settings"
const MAX_JSON_BYTES = 64 * 1024
const CONTENT_TYPES = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
])
export function securityHeaders(response: ServerResponse) {
  response.setHeader("cache-control", "no-store")
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
  response.setHeader("cross-origin-resource-policy", "same-origin")
  response.setHeader("referrer-policy", "no-referrer")
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("x-frame-options", "DENY")
}

export function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.end(JSON.stringify(value))
}

export function requestIsAuthenticated(request: IncomingMessage, token: string) {
  const cookies = String(request.headers.cookie || "")
    .split(";")
    .map((value) => value.trim().split("="))
  return cookies.some(([name, value]) => name === COOKIE_NAME && value === token)
}

export async function readBody(request: IncomingMessage, maximumBytes: number) {
  const chunks: Buffer[] = []
  let bytes = 0
  let tooLarge = false
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += buffer.length
    if (bytes > maximumBytes) tooLarge = true
    else chunks.push(buffer)
  }
  if (tooLarge) {
    throw Object.assign(
      new Error(`Request body exceeds ${Math.round(maximumBytes / 1024 / 1024)} MB.`),
      { code: "BODY_TOO_LARGE" },
    )
  }
  return Buffer.concat(chunks)
}

export async function readJsonBody(request: IncomingMessage) {
  const body = await readBody(request, MAX_JSON_BYTES)
  try {
    return JSON.parse(body.toString("utf8") || "{}") as unknown
  } catch (cause) {
    throw new Error("Invalid JSON request body.", { cause })
  }
}

export function statusForError(error: unknown) {
  if (errorCode(error) === "BODY_TOO_LARGE") return 413
  if (error instanceof BackgroundStateError) return error.code === "RESTART_REQUIRED" ? 409 : 400
  return 400
}

export async function serveStaticFile(response: ServerResponse, pathname: string, uiRoot: string) {
  const relativePath =
    pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "")
  const filePath = path.resolve(uiRoot, relativePath)
  if (filePath !== uiRoot && !filePath.startsWith(`${uiRoot}${path.sep}`)) return false
  try {
    const metadata = await stat(filePath)
    if (!metadata.isFile()) return false
    response.statusCode = 200
    response.setHeader(
      "content-type",
      CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
    )
    response.end(await readFile(filePath))
    return true
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}
