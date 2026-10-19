import { useState } from "react"

import { defaultConfig } from "../model.ts"
import type {
  BackgroundConfig,
  BackgroundSurface,
  SurfaceBackgroundConfig,
  WallpaperConfig,
} from "../types.ts"

/** Server acknowledgements replace the draft only after explicit configuration actions. */
export function useSettingsDraft() {
  const [config, setConfig] = useState<BackgroundConfig>(defaultConfig)
  const updateSurfaceConfig = <Key extends keyof SurfaceBackgroundConfig>(
    surface: BackgroundSurface,
    key: Key,
    value: SurfaceBackgroundConfig[Key],
  ) => {
    setConfig((current) => ({
      ...current,
      surfaces: {
        ...current.surfaces,
        [surface]: { ...current.surfaces[surface], [key]: value },
      },
    }))
  }

  const updateWallpaperConfig = <Key extends keyof WallpaperConfig>(
    key: Key,
    value: WallpaperConfig[Key],
  ) => {
    setConfig((current) => ({
      ...current,
      wallpaper: { ...current.wallpaper, [key]: value },
    }))
  }

  const updatePosition = (
    surface: BackgroundSurface,
    illustrationX: number,
    illustrationY: number,
  ) => {
    setConfig((current) => ({
      ...current,
      surfaces: {
        ...current.surfaces,
        [surface]: { ...current.surfaces[surface], illustrationX, illustrationY },
      },
    }))
  }

  return { config, setConfig, updateSurfaceConfig, updateWallpaperConfig, updatePosition }
}
