import { useCallback, useEffect, useRef, useState } from "react"

import { api } from "../model.ts"
import type { BackgroundStatus } from "../types.ts"

/** Refresh only runtime status; never replace an unsaved configuration draft. */
export function useRuntimeStatus() {
  const [status, setStatus] = useState<BackgroundStatus | null>(null)
  const [connectionFailed, setConnectionFailed] = useState(false)
  const pending = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const updateStatus = useCallback((next: BackgroundStatus) => {
    generation.current += 1
    pending.current?.abort()
    pending.current = null
    setStatus(next)
    setConnectionFailed(false)
  }, [])
  useEffect(() => {
    let active = true
    const refresh = async () => {
      if (document.hidden || pending.current) return
      const request = new AbortController()
      const version = generation.current
      pending.current = request
      let timedOut = false
      const timeout = window.setTimeout(() => {
        timedOut = true
        request.abort()
      }, 5000)
      try {
        const payload = await api<{ status: BackgroundStatus }>("/api/status", {
          signal: request.signal,
        })
        if (active && !request.signal.aborted && version === generation.current) {
          setStatus(payload.status)
          setConnectionFailed(false)
        }
      } catch {
        if (active && (timedOut || !request.signal.aborted) && version === generation.current)
          setConnectionFailed(true)
      } finally {
        window.clearTimeout(timeout)
        if (pending.current === request) pending.current = null
      }
    }
    const onForeground = () => {
      void refresh()
    }
    const timer = window.setInterval(onForeground, 2000)
    window.addEventListener("focus", onForeground)
    document.addEventListener("visibilitychange", onForeground)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener("focus", onForeground)
      document.removeEventListener("visibilitychange", onForeground)
      pending.current?.abort()
      pending.current = null
    }
  }, [])
  return { status, updateStatus, connectionFailed, setConnectionFailed }
}
