export type {
  BackgroundSurface,
  BackgroundConfig,
  WallpaperConfig,
  SurfaceBackgroundConfig,
  BackgroundApplication,
  BackgroundStatus,
  StatePayload,
  BundledBackgroundOption,
  BundledBackgroundGroup,
  BundledBackgroundCatalog,
  RuntimeSnapshot,
} from "../shared/protocol.ts"
import type { BackgroundSurface } from "../shared/protocol.ts"
export type BackgroundSettingsTab = "wallpaper" | BackgroundSurface

export type BusyAction =
  | "image"
  | "menu-bar-icon"
  | "save"
  | "start"
  | "surface-toggle"
  | "toggle"
  | null
export type PreviewTheme = "system" | "light" | "dark"
export type RangeKey =
  | "backgroundTransparency"
  | "illustrationSize"
  | "illustrationBlur"
  | "illustrationOpacity"
  | "illustrationX"
  | "illustrationY"
  | "wallpaperPositionX"
  | "wallpaperPositionY"
