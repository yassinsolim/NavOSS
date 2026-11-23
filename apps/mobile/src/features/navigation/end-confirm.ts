/** How long a first key press on End waits for the second one. */
export const END_CONFIRM_MS = 4000;

/**
 * What a press on the trip's End control does. A touch ends the trip at once, as it always has on
 * both platforms. On Android a press from a key (A, Enter, D-pad centre: the control had keyboard
 * focus) only arms it: on a handheld a stray button press must not end guidance, so a second key
 * press within `END_CONFIRM_MS` ends it.
 */
export function endPress({
  armedAt,
  keyActivated,
  now,
  platform,
}: {
  armedAt: number | undefined;
  keyActivated: boolean;
  now: number;
  platform: string;
}): 'arm' | 'end' {
  if (platform !== 'android' || !keyActivated) return 'end';
  return armedAt !== undefined && now - armedAt <= END_CONFIRM_MS ? 'end' : 'arm';
}
