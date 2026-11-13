import type { RouteLane, RouteLaneIndication, RouteStepV2 } from '@navoss/contracts';

export interface LaneArrow {
  /** The arrow to follow in this lane; the rest are painted on the lane but lead elsewhere. */
  highlighted: boolean;
  indication: RouteLaneIndication;
}

export interface LaneTile {
  /** Every arrow painted on the lane, highlighted one last so it draws on top. */
  arrows: LaneArrow[];
  /**
   * `recommended`: the router prefers it; `usable`: it also follows the route; `other`: it does
   * not.
   */
  state: 'other' | 'recommended' | 'usable';
}

export interface LaneStrip {
  accessibilityLabel: string;
  tiles: LaneTile[];
}

/**
 * The lane strip for an upcoming maneuver, or `undefined` when there is nothing trustworthy to
 * show: no lanes, a lane with no arrows, or no lane that follows the route (highlighting nothing
 * would tell the driver every lane is wrong). Mirrors CarPlay's `navOSSCarPlayLaneSpecs`.
 */
export function laneStrip(lanes: readonly RouteLane[] | undefined): LaneStrip | undefined {
  if (
    lanes === undefined ||
    lanes.length === 0 ||
    lanes.some((lane) => lane.indications.length === 0) ||
    !lanes.some((lane) => lane.valid)
  ) {
    return undefined;
  }
  // Lanes the router marks active narrow the choice; without any, every valid lane is equal.
  const anyRecommended = lanes.some((lane) => lane.valid && lane.active === true);
  const tiles = lanes.map((lane): LaneTile => {
    const indications = [...new Set(lane.indications)];
    const followed = lane.valid
      ? lane.validIndication !== undefined && indications.includes(lane.validIndication)
        ? lane.validIndication
        : indications[0]
      : undefined;
    return {
      arrows: [
        ...indications
          .filter((indication) => indication !== followed)
          .map((indication) => ({ highlighted: false, indication })),
        ...(followed === undefined ? [] : [{ highlighted: true, indication: followed }]),
      ],
      state: !lane.valid
        ? 'other'
        : !anyRecommended || lane.active === true
          ? 'recommended'
          : 'usable',
    };
  });
  return { accessibilityLabel: laneAccessibilityLabel(tiles), tiles };
}

function laneAccessibilityLabel(tiles: readonly LaneTile[]): string {
  const positions = tiles.flatMap((tile, index) =>
    tile.state === 'recommended' ? [index + 1] : [],
  );
  const total = tiles.length;
  if (positions.length === 1) return `Use lane ${String(positions[0])} of ${String(total)}`;
  const contiguous = positions.every(
    (position, index) => index === 0 || position === (positions[index - 1] ?? 0) + 1,
  );
  const first = positions[0] ?? 0;
  const last = positions.at(-1) ?? 0;
  return contiguous
    ? `Use lanes ${String(first)} to ${String(last)} of ${String(total)}`
    : `Use lanes ${positions.slice(0, -1).join(', ')} or ${String(last)} of ${String(total)}`;
}

export interface ManeuverSignage {
  /** "Exit 248", or "2nd exit" at a roundabout; only from route data. */
  exitLabel?: string;
  /** "toward Glenmore Trail West", from the signposted destinations. */
  toward?: string;
}

const ORDINAL_SUFFIX = ['th', 'st', 'nd', 'rd'] as const;

function ordinal(value: number): string {
  const remainder = value % 100;
  const suffix = remainder >= 11 && remainder <= 13 ? 'th' : (ORDINAL_SUFFIX[value % 10] ?? 'th');
  return `${String(value)}${suffix}`;
}

/**
 * What the signs at a maneuver say, from the route's own data: the exit number (or the
 * roundabout exit to take) and where the road leads. Absent data produces nothing.
 */
export function maneuverSignage(
  step: Pick<RouteStepV2, 'exitNumber' | 'maneuverType' | 'roundaboutExit' | 'signpostToward'>,
): ManeuverSignage {
  const roundabout = /roundabout|rotary/i.test(step.maneuverType);
  const exitLabel =
    step.exitNumber !== undefined
      ? `Exit ${step.exitNumber}`
      : roundabout && step.roundaboutExit !== undefined
        ? `${ordinal(step.roundaboutExit)} exit`
        : undefined;
  // Branches are route numbers ("2 South"), not places, so only "toward" elements are used.
  const toward =
    step.signpostToward === undefined
      ? undefined
      : `toward ${step.signpostToward.slice(0, 2).join(' / ')}`;
  return {
    ...(exitLabel === undefined ? {} : { exitLabel }),
    ...(toward === undefined ? {} : { toward }),
  };
}
