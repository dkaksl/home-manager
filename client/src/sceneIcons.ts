export const SCENE_ICONS: Record<string, string> = {
  'Natural light': '☀️',
  'Read': '📖',
  'Reading': '📖',
  'Rest': '😌',
  'Nightlight': '🌙',
  'Concentrate': '🎯',
  'Energize': '⚡',
  'Bright': '💡',
  'Dimmed': '🕯',
  'Relax': '🛋',
  'TV time': '📺',
  'Savanna sunset': '🌅',
  'Tropical twilight': '🌺',
}

export const sceneIcon = (name: string): string => SCENE_ICONS[name] ?? '✨'
