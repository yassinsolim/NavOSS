import { NativeModule, requireOptionalNativeModule } from 'expo';

/** What a handheld's map controls ask for: L1, R1 and pressing the right stick. */
export type MapCommand = 'recenter' | 'zoom-in' | 'zoom-out';

// A type alias, not an interface, so it satisfies Expo's `EventsMap` index signature.
type NavOSSInputEvents = {
  onMapCommand: (event: { command: MapCommand }) => void;
  /** The right stick, each axis -1..1 (x right, y down); 0, 0 when released. */
  onMapStick: (event: { x: number; y: number }) => void;
};

declare class NavOSSInputModule extends NativeModule<NavOSSInputEvents> {
  /**
   * Moves keyboard focus to the view with this tag when the driver is using keys (Android is not
   * in touch mode). Resolves whether it took focus; a touch user never sees a focus ring.
   */
  focusForKeys(viewTag: number): Promise<boolean>;
}

/** Android only; `null` on iOS. */
export const NavOSSInput = requireOptionalNativeModule<NavOSSInputModule>('NavOSSInput');
