/** Colour of the status-bar clock and battery: `light` is white content, `dark` is black. */
export type StatusBarContent = 'auto' | 'dark' | 'light';

/**
 * Status-bar content that stays legible over what is actually drawn behind it. The map runs
 * under the status bar (the maneuver banner and every sheet start below it), so while the map is
 * showing the basemap decides: white over a dark basemap, black over a light one, whatever the
 * system appearance is (a light basemap in a dark system, or the reverse, is a choice the driver
 * can make). Full-screen pages that replace the map paint the system background, so the system
 * decides there.
 */
export function statusBarContent({
  darkMap,
  mapVisible,
}: {
  darkMap: boolean;
  mapVisible: boolean;
}): StatusBarContent {
  if (!mapVisible) return 'auto';
  return darkMap ? 'light' : 'dark';
}

/** expo-navigation-bar's style names the bar itself: a `light` bar has dark buttons. */
export type NavigationBarStyle = 'auto' | 'dark' | 'light';

/**
 * Android's 3-button navigation bar is drawn over the map like the status bar (edge to edge, no
 * contrast scrim), so its buttons follow the same content colour as the status bar.
 */
export function navigationBarStyleFor(content: StatusBarContent): NavigationBarStyle {
  if (content === 'auto') return 'auto';
  return content === 'dark' ? 'light' : 'dark';
}
