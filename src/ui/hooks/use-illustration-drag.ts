import { useEffect, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"

import { backgroundPositionFromDrag } from "../model.ts"
import type { BackgroundConfig, BackgroundSurface } from "../types.ts"

interface IllustrationDragState {
  animationFrame?: number
  illustrationHeight: number
  illustrationWidth: number
  initialX: number
  initialY: number
  pendingPosition?: { x: number; y: number }
  pointerId: number
  pointerX: number
  pointerY: number
  stageHeight: number
  stageWidth: number
  surface: BackgroundSurface
}

export function useIllustrationDrag(
  config: BackgroundConfig,
  setActiveTab: (surface: BackgroundSurface) => void,
  updatePosition: (surface: BackgroundSurface, x: number, y: number) => void,
) {
  const [illustrationDragging, setIllustrationDragging] = useState<BackgroundSurface>()
  const mainStageRef = useRef<HTMLDivElement>(null)
  const sidebarStageRef = useRef<HTMLDivElement>(null)
  const placementStageRefs = { main: mainStageRef, sidebar: sidebarStageRef }
  const illustrationDragRef = useRef<IllustrationDragState | undefined>(undefined)
  useEffect(
    () => () => {
      const frame = illustrationDragRef.current?.animationFrame
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    },
    [],
  )
  const positionForPointer = (
    drag: IllustrationDragState,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => ({
    x: backgroundPositionFromDrag({
      illustrationLength: drag.illustrationWidth,
      initialPosition: drag.initialX,
      pointerDelta: event.clientX - drag.pointerX,
      stageLength: drag.stageWidth,
    }),
    y: backgroundPositionFromDrag({
      illustrationLength: drag.illustrationHeight,
      initialPosition: drag.initialY,
      pointerDelta: event.clientY - drag.pointerY,
      stageLength: drag.stageHeight,
    }),
  })

  const flushIllustrationPosition = () => {
    const drag = illustrationDragRef.current
    if (!drag) return
    drag.animationFrame = undefined
    const position = drag.pendingPosition
    if (!position) return
    drag.pendingPosition = undefined
    updatePosition(drag.surface, position.x, position.y)
  }

  const startIllustrationDrag = (
    surface: BackgroundSurface,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault()
    const stageBounds = placementStageRefs[surface].current?.getBoundingClientRect()
    if (!stageBounds) return
    const illustrationBounds = event.currentTarget.getBoundingClientRect()
    const surfaceConfig = config.surfaces[surface]
    setActiveTab(surface)
    illustrationDragRef.current = {
      illustrationHeight: illustrationBounds.height,
      illustrationWidth: illustrationBounds.width,
      initialX: surfaceConfig.illustrationX,
      initialY: surfaceConfig.illustrationY,
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      stageHeight: stageBounds.height,
      stageWidth: stageBounds.width,
      surface,
    }
    setIllustrationDragging(surface)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveIllustration = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = illustrationDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.pendingPosition = positionForPointer(drag, event)
    if (drag.animationFrame === undefined) {
      drag.animationFrame = window.requestAnimationFrame(flushIllustrationPosition)
    }
  }

  const finishIllustrationDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = illustrationDragRef.current
    if (drag?.pointerId === event.pointerId) {
      if (drag.animationFrame !== undefined) window.cancelAnimationFrame(drag.animationFrame)
      const position = positionForPointer(drag, event)
      updatePosition(drag.surface, position.x, position.y)
      illustrationDragRef.current = undefined
    }
    setIllustrationDragging(undefined)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return {
    illustrationDragging,
    placementStageRefs,
    startIllustrationDrag,
    moveIllustration,
    finishIllustrationDrag,
  }
}
