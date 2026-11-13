# Interaction patterns already in use

Each pattern names where it lives. Reuse before inventing.

| Pattern                                | Where                                                            | Notes                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Details-first destination flow         | place sheet, then explicit Directions, route preview, Start, End | Start never happens from a search tap. CarPlay mirrors it: preview, then Go.                       |
| Bottom sheet with detents              | `src/ui/sheet`                                                   | One shared value; drag, fling, settle; keyboard-aware; Reduce Motion opens at the final position.  |
| Floating controls on the sheet edge    | `components/map-controls.tsx`                                    | Glass on iOS 26 with a solid fallback.                                                             |
| `StateView` for loading, empty, error  | `src/ui/state-view.tsx`                                          | Polite live region; `tone="danger"` is announced as an alert.                                      |
| `Banner` for degraded state            | `src/ui/banner.tsx`                                              | Tones `danger`, `info`, `neutral`, `warning`; `announce` only for states that appear on their own. |
| Map notice pill                        | `components/map-notice.tsx`                                      | Transient, Reduce-Motion aware.                                                                    |
| Ask-first reroute                      | guidance banner (phone), `CPNavigationAlert` (CarPlay)           | Shows the real time and distance change; withdrawn when the core withdraws it.                     |
| Opt-in switch with a plain consequence | CarPlay Settings ▸ Community; phone about/guidance settings      | Off by default; detail line states what happens in each state.                                     |
| Private-by-default report              | report picker, CarPlay report grid                               | Title says private or shared before a type is chosen; near-private-place guard.                    |
| Lane strip and exit sign               | maneuver banner `children` seam                                  | Hidden when data is absent or untrustworthy (`lane-guidance.ts`).                                  |
| Haptics on commit                      | `src/theme/haptics.ts`                                           | Selections and committed actions only.                                                             |
