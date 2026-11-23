/**
 * Props that keep a pressable out of D-pad focus, for one it hides (a row below a collapsed
 * sheet's edge) or a surface that is not a control (a modal's scrim). On Android React Native's
 * `focusable={false}` alone does not do it: `accessible`, true by default on a pressable, makes the
 * view focusable again, and `accessible={false}` alone loses to the `focusable` a pressable sends,
 * so both are off. A hidden view leaves TalkBack too; its texts would otherwise become separate
 * elements. Nothing changes on iOS.
 */
export function hiddenFromFocusProps(platform: string): {
  accessible?: false;
  focusable?: false;
  importantForAccessibility?: 'no-hide-descendants';
} {
  return platform === 'android'
    ? { accessible: false, focusable: false, importantForAccessibility: 'no-hide-descendants' }
    : {};
}
