# Interface quality: tokens and primitives (phone)

Source of truth: `apps/mobile/src/theme/tokens.ts` and `apps/mobile/src/ui/*`. Read the file, not this summary, before changing a value.

## Tokens

- **Colour roles** (`ColorRoles`, `lightColors`, `darkColors`): components use roles (`surface`, `surfaceRaised`, `surfaceSunken`, `text`, `textSecondary`, `textTertiary`, `primary`, `primaryText`, `danger`, `dangerText`, `warning`, `warningText`, `border`, `scrim`, ...), never raw hex. `useTheme()` follows the system appearance; there is no in-app override. `createThemedStyles` caches one style sheet per scheme.
- **Palette seed** (shared with the site and CarPlay): ink `#0E1516`, paper `#F6F7F3`, primary teal `#0F8F7F` on light and `#3DD6B5` on dark, sun `#F7C948`, coral `#E5484D`, amber `#F59E0B`.
- **Traffic ramp** `trafficColors`: free `#2FBF71`, slow `#F5A524`, heavy `#E5484D`, stopped `#8B1E2D`. Do not invent intermediate colours.
- **Guidance** `guidanceColors`: active guidance is always drawn on ink in both schemes, so the banner is identical at noon and at night and never flashes when the system appearance flips.
- **Type** `typography`: Atkinson Hyperlegible Next (`fonts`). Body 16/22; guidance sizes are deliberately large (`guidanceDistance` 38, `guidanceInstruction` 24, `guidanceMetric` 26, `guidanceRoad` 18).
- **Space** `space` (xs 4, sm 8, md 12, lg 16, xl 20, xxl 24, xxxl 32), **radius** `radius` (sm 8 to sheet 26, pill), **elevation** `low|medium|high`.
- **Touch targets** `touchTarget`: `min` 44, `driving` 56. Controls a driver reaches for during guidance use `driving`.
- **Motion** `motion.duration` (instant 90, fast 150, base 220, slow 320 ms) and `motion.spring` (`press`, `sheet`). Every animation passes `ReduceMotion.System`.
- **Haptics** `theme/haptics.ts`: confirm selections and committed actions only.

## Primitives (`src/ui`)

`Button` (sizes include a 56 pt driving size), `IconButton` (requires `accessibilityLabel`, never smaller than 44), `Chip`, `ListRow`, `Banner` (tones `danger|info|neutral|warning`, optional live-region announcement), `StateView` (loading, empty and error in one shape, `row` or `block`), `SegmentedControl`, `GlassSurface` (iOS 26 Liquid Glass with a solid fallback), `PressableScale`, and the sheets (`BottomSheet`, `ModalSheet`, `SheetHeader`). Sheet geometry is pure and tested (`sheet-detents.ts`).

## Rules

- Use a primitive before writing a new one; extend a primitive before forking it.
- Text uses `typography` plus a role colour. Cap Dynamic Type with `maxFontSizeMultiplier` where growth would break the surface (the code uses 1.2 for map chrome and tab labels, 1.3 on guidance, 1.4 to 1.5 in sheets and `StateView`/`Banner`); see `references/coverage-gaps.md` for the missing standard.
- Contrast is tested: every text role on every surface in both schemes (`apps/mobile/test/theme-contrast.test.ts`). A new role or surface needs a row there.
- Sheets are driven by one shared value on the UI thread; do not drive sheet-adjacent animation from React state.
- The map screen is a composition root (`map-screen.tsx`); behaviour belongs in `features/map/controller/*` hooks. Camera frames go to a shared value, not React state; measure with `EXPO_PUBLIC_NAVOSS_RENDER_COUNTS=1`.
- Symbols: `expo-symbols` `SymbolView` with an `{ ios, android }` pair.
