import { createHash } from 'node:crypto';

import {
  RouteAlternativeV2Schema,
  type RouteAlternativeV2,
  type RouteLane,
  type RouteLaneIndication,
  type RouteSpeedLimit,
  type RouteRequestV2,
  type RouteStepV2,
} from '@navoss/contracts';
import protobuf from 'protobufjs/light.js';
import { z } from 'zod/v4';

import descriptor from './valhalla-proto-3.8.2.json' with { type: 'json' };

// Generated from the exact production image's 3.8.2 .proto. The light runtime skips unknown
// fields, and neither loads a .proto parser nor downloads schemas at request time.
const ApiType = protobuf.Root.fromJSON(descriptor.schema).lookupType('valhalla.Api');
const UIntSchema = z.number().int().nonnegative();
const StreetNameSchema = z.object({ value: z.string(), isRouteNumber: z.boolean().default(false) });
const ManeuverSchema = z.looseObject({
  beginShapeIndex: UIntSchema.default(0),
  endShapeIndex: UIntSchema.default(0),
  length: z.number().nonnegative().default(0),
  streetName: z.array(StreetNameSchema).default([]),
  textInstruction: z.string().min(1),
  time: z.number().nonnegative().default(0),
  type: UIntSchema.default(0),
});
const LegSchema = z.object({
  maneuver: z.array(ManeuverSchema).min(1),
  shape: z.string().min(1),
  summary: z.object({
    length: z.number().nonnegative().default(0),
    time: z.number().nonnegative().default(0),
  }),
});
const ResponseSchema = z.object({
  directions: z.object({ routes: z.array(z.object({ legs: z.array(LegSchema).min(1) })).min(1) }),
  trip: z.unknown().optional(),
});
const TripSchema = z.object({
  routes: z.array(
    z.object({
      legs: z.array(
        z.object({
          node: z.array(z.unknown()).default([]),
          shapeAttributes: z.unknown().optional(),
        }),
      ),
    }),
  ),
});
const EdgeSchema = z.object({
  edge: z.object({
    beginHeading: z.unknown().optional(),
    endHeading: z.unknown().optional(),
    name: z.unknown().optional(),
    turnLanes: z.unknown().optional(),
  }),
});
const NativeLaneSchema = z.object({
  activeDirection: UIntSchema.max(2047).default(0),
  directionsMask: UIntSchema.max(2047).default(0),
  state: z.number().int().min(0).max(2).default(0),
});
const NativeSignSchema = z.object({
  exitNames: z.array(z.object({ text: z.string().min(1) })).default([]),
  exitNumbers: z.array(z.object({ text: z.string().min(1) })).default([]),
  exitOntoStreets: z.array(z.object({ text: z.string().min(1) })).default([]),
  exitTowardLocations: z.array(z.object({ text: z.string().min(1) })).default([]),
  guideOntoStreets: z.array(z.object({ text: z.string().min(1) })).default([]),
  guideTowardLocations: z.array(z.object({ text: z.string().min(1) })).default([]),
  junctionNames: z.array(z.object({ text: z.string().min(1) })).default([]),
});
const BearingSchema = z.number().min(0).lt(360);
const NativeSpeedLimitsSchema = z.object({ speedLimit: z.array(UIntSchema.max(255)).min(1) });
const NativeLanesSchema = z.array(NativeLaneSchema).min(1);
const NativeStreetNamesSchema = z.array(StreetNameSchema);
const PositiveUIntSchema = UIntSchema.positive();
const ErrorStatusSchema = z.object({
  info: z.object({ errors: z.array(z.unknown()).default([]) }).optional(),
});

// Valhalla 3.8.2 TurnLane::directions_mask; wire bits and lane order are preserved.
const LANE_DIRECTIONS: readonly (readonly [number, RouteLaneIndication])[] = [
  [1, 'none'],
  [2, 'straight'],
  [4, 'sharp_left'],
  [8, 'left'],
  [16, 'slight_left'],
  [32, 'slight_right'],
  [64, 'right'],
  [128, 'sharp_right'],
  [256, 'uturn'],
  [512, 'merge_left'],
  [1024, 'merge_right'],
];
const MANEUVERS: Readonly<Record<number, readonly [string, RouteStepV2['maneuverModifier']?]>> = {
  0: ['notification'],
  1: ['depart'],
  2: ['depart'],
  3: ['depart'],
  4: ['arrive'],
  5: ['arrive'],
  6: ['arrive'],
  7: ['new name'],
  8: ['continue', 'straight'],
  9: ['turn', 'slight right'],
  10: ['turn', 'right'],
  11: ['turn', 'sharp right'],
  12: ['turn', 'uturn'],
  13: ['turn', 'uturn'],
  14: ['turn', 'sharp left'],
  15: ['turn', 'left'],
  16: ['turn', 'slight left'],
  17: ['on ramp', 'straight'],
  18: ['on ramp', 'slight right'],
  19: ['on ramp', 'slight left'],
  20: ['off ramp', 'slight right'],
  21: ['off ramp', 'slight left'],
  22: ['fork', 'straight'],
  23: ['fork', 'slight right'],
  24: ['fork', 'slight left'],
  25: ['merge'],
  26: ['roundabout'],
  27: ['exit roundabout'],
  28: ['ferry'],
  29: ['exit ferry'],
  37: ['merge', 'slight right'],
  38: ['merge', 'slight left'],
};

export class ValhallaDecodeError extends Error {
  public constructor(options?: ErrorOptions) {
    super('The lossless route response could not be decoded.', options);
    this.name = 'ValhallaDecodeError';
  }
}
export class ValhallaRoutingError extends Error {
  public constructor() {
    super('Valhalla reported a routing error.');
    this.name = 'ValhallaRoutingError';
  }
}

function decodePolyline6(encoded: string): [number, number][] {
  const coordinates: [number, number][] = [];
  let latitude = 0;
  let longitude = 0;
  let cursor = 0;
  function delta(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (cursor >= encoded.length || shift > 30) throw new ValhallaDecodeError();
      byte = encoded.charCodeAt(cursor++) - 63;
      if (byte < 0 || byte > 63) throw new ValhallaDecodeError();
      result |= (byte & 31) << shift;
      shift += 5;
    } while (byte >= 32);
    return (result & 1) !== 0 ? ~(result >>> 1) : result >>> 1;
  }
  while (cursor < encoded.length) {
    latitude += delta();
    longitude += delta();
    coordinates.push([longitude / 1_000_000, latitude / 1_000_000]);
  }
  return coordinates;
}

function roadName(names: z.infer<typeof StreetNameSchema>[]): string {
  const named = names
    .filter((name) => !name.isRouteNumber)
    .map((name) => name.value)
    .filter(Boolean);
  return (named.length === 0 ? names.map((name) => name.value).filter(Boolean) : named).join('; ');
}
function edgeAt(nodes: unknown[], index: number) {
  const parsed = EdgeSchema.safeParse(nodes[index]);
  return parsed.success ? parsed.data.edge : undefined;
}
function lanesFor(value: unknown): RouteLane[] | undefined {
  const parsed = NativeLanesSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const lanes: RouteLane[] = [];
  for (const lane of parsed.data) {
    const valid = lane.state === 1 || lane.state === 2;
    if (
      valid &&
      (lane.activeDirection === 0 ||
        (lane.activeDirection & lane.directionsMask) !== lane.activeDirection)
    )
      return undefined;
    const indications: RouteLaneIndication[] = [];
    let validIndication: RouteLaneIndication | undefined;
    let validDirectionCount = 0;
    for (const [bit, indication] of LANE_DIRECTIONS) {
      if ((lane.directionsMask & bit) !== 0) indications.push(indication);
      if ((lane.activeDirection & bit) !== 0) {
        validIndication = indication;
        validDirectionCount += 1;
      }
    }
    lanes.push({
      active: lane.state === 2,
      indications,
      valid,
      ...(valid && validDirectionCount === 1 && validIndication !== undefined
        ? { validIndication }
        : {}),
    });
  }
  return lanes;
}
function signpostFor(
  value: unknown,
): Pick<
  RouteStepV2,
  'exitNumber' | 'junctionName' | 'signpost' | 'signpostBranch' | 'signpostToward'
> {
  const parsed = NativeSignSchema.safeParse(value);
  if (!parsed.success) return {};
  const sign = parsed.data;
  const exit =
    sign.exitOntoStreets.length > 0 ||
    sign.exitTowardLocations.length > 0 ||
    sign.exitNames.length > 0;
  const branch = (exit ? sign.exitOntoStreets : sign.guideOntoStreets).map(
    (element) => element.text,
  );
  const toward = (exit ? sign.exitTowardLocations : sign.guideTowardLocations).map(
    (element) => element.text,
  );
  const exitNumber = sign.exitNumbers.map((element) => element.text).join(', ');
  const junctionName = (sign.junctionNames.length > 0 ? sign.junctionNames : sign.exitNames)
    .map((element) => element.text)
    .join(', ');
  const signpost =
    [branch.join(', '), toward.join(', ')].filter(Boolean).join(': ') || junctionName;
  return {
    ...(exitNumber === '' ? {} : { exitNumber }),
    ...(junctionName === '' ? {} : { junctionName }),
    ...(signpost === '' ? {} : { signpost }),
    ...(branch.length === 0 ? {} : { signpostBranch: branch }),
    ...(toward.length === 0 ? {} : { signpostToward: toward }),
  };
}
function speedLimitsFor(value: unknown): RouteSpeedLimit[] | undefined {
  const parsed = NativeSpeedLimitsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const limits: RouteSpeedLimit[] = [];
  for (const kph of parsed.data.speedLimit) {
    if (kph === 0) limits.push({ status: 'unknown' });
    else if (kph === 255) limits.push({ status: 'unlimited' });
    else if (kph > 250) return undefined;
    else limits.push({ status: 'known', kph });
  }
  return limits;
}

export function normalizeValhallaPbfResponse(payload: unknown): RouteAlternativeV2[] {
  const status = ErrorStatusSchema.safeParse(payload);
  if (status.success && (status.data.info?.errors.length ?? 0) > 0)
    throw new ValhallaRoutingError();
  const parsed = ResponseSchema.safeParse(payload);
  if (!parsed.success) throw new ValhallaDecodeError();
  const trip = TripSchema.safeParse(parsed.data.trip);
  return parsed.data.directions.routes.map((route, routeIndex) => {
    const geometry: [number, number][] = [];
    const steps: RouteStepV2[] = [];
    const limits: RouteSpeedLimit[] = [];
    let limitsComplete = true;
    let distanceMeters = 0;
    let durationSeconds = 0;
    route.legs.forEach((leg, legIndex) => {
      const shape = decodePolyline6(leg.shape);
      if (shape.length < 2) throw new ValhallaDecodeError();
      // Adjacent legs share one waypoint vertex, not a duplicate geometry segment.
      for (let index = geometry.length === 0 ? 0 : 1; index < shape.length; index += 1) {
        const position = shape[index];
        if (position !== undefined) geometry.push(position);
      }
      const metadata = trip.success ? trip.data.routes[routeIndex]?.legs[legIndex] : undefined;
      const legLimits = speedLimitsFor(metadata?.shapeAttributes);
      if (legLimits?.length === shape.length - 1) limits.push(...legLimits);
      else limitsComplete = false;
      distanceMeters += leg.summary.length * 1_000;
      durationSeconds += leg.summary.time;
      for (const maneuver of leg.maneuver) {
        if (
          maneuver.beginShapeIndex > maneuver.endShapeIndex ||
          maneuver.endShapeIndex >= shape.length ||
          (maneuver.beginShapeIndex === maneuver.endShapeIndex && maneuver.length > 0)
        )
          throw new ValhallaDecodeError();
        const stepGeometry = shape.slice(maneuver.beginShapeIndex, maneuver.endShapeIndex + 1);
        if (stepGeometry.length === 1 && stepGeometry[0] !== undefined)
          stepGeometry.push(stepGeometry[0]);
        const pathIndex = UIntSchema.safeParse(maneuver.beginPathIndex);
        const incoming =
          pathIndex.success && pathIndex.data > 0
            ? edgeAt(metadata?.node ?? [], pathIndex.data - 1)
            : undefined;
        const outgoing = pathIndex.success
          ? edgeAt(metadata?.node ?? [], pathIndex.data)
          : undefined;
        const laneData = lanesFor(incoming?.turnLanes);
        const before = BearingSchema.safeParse(incoming?.endHeading);
        const after = BearingSchema.safeParse(outgoing?.beginHeading ?? maneuver.beginHeading);
        const roundabout = PositiveUIntSchema.safeParse(maneuver.roundaboutExitCount);
        const names = roadName(maneuver.streetName);
        const edgeNames = NativeStreetNamesSchema.safeParse(outgoing?.name);
        const currentRoadName = names || (edgeNames.success ? roadName(edgeNames.data) : '');
        const [maneuverType, maneuverModifier] = MANEUVERS[maneuver.type] ?? [
          `valhalla-${String(maneuver.type)}`,
        ];
        steps.push({
          distanceMeters: maneuver.length * 1_000,
          durationSeconds: maneuver.time,
          geometry: stepGeometry,
          instruction: maneuver.textInstruction,
          maneuverType,
          roadName: names,
          ...(currentRoadName === '' ? {} : { currentRoadName }),
          ...(maneuverModifier === undefined ? {} : { maneuverModifier }),
          ...(before.success ? { bearingBeforeDegrees: before.data } : {}),
          ...(after.success ? { bearingAfterDegrees: after.data } : {}),
          ...(roundabout.success ? { roundaboutExit: roundabout.data } : {}),
          ...(laneData === undefined ? {} : { lanes: laneData }),
          ...signpostFor(maneuver.sign),
          ...(typeof maneuver.verbalPreTransitionInstruction === 'string' &&
          maneuver.verbalPreTransitionInstruction !== ''
            ? { spokenInstruction: maneuver.verbalPreTransitionInstruction }
            : {}),
        });
      }
    });
    const normalized = {
      distanceMeters,
      durationSeconds,
      geometry,
      id: `valhalla-${String(routeIndex + 1)}-${createHash('sha256')
        .update(
          JSON.stringify([
            distanceMeters,
            durationSeconds,
            geometry,
            steps,
            limitsComplete ? limits : undefined,
          ]),
        )
        .digest('hex')
        .slice(0, 16)}`,
      label: 'alternative' as const,
      steps,
      ...(limitsComplete && limits.length === geometry.length - 1
        ? {
            speedLimits: limits,
            // Legacy consumers still use zero for both unknown and unlimited. New consumers do not.
            speedLimitsKph: limits.map((limit) => (limit.status === 'known' ? limit.kph : 0)),
          }
        : {}),
    };
    // Optional metadata is independently validated/omitted above. No second route computation
    // or legacy-object projection is needed to validate a correctly decoded base route.
    if (!RouteAlternativeV2Schema.safeParse(normalized).success) throw new ValhallaDecodeError();
    return normalized;
  });
}

export function parseValhallaPbf(bytes: Uint8Array): RouteAlternativeV2[] {
  let payload: unknown;
  try {
    payload = ApiType.toObject(ApiType.decode(bytes), { arrays: true });
  } catch (error: unknown) {
    throw new ValhallaDecodeError({ cause: error });
  }
  return normalizeValhallaPbfResponse(payload);
}

export function buildValhallaPbfRequest(request: RouteRequestV2): Uint8Array {
  const locations = [request.origin, ...(request.waypoints ?? []), request.destination].map(
    (coordinate, index) => ({
      ll: { lat: coordinate.latitude, lng: coordinate.longitude },
      type: 'type' in coordinate && coordinate.type === 'through' ? 1 : 0,
      ...(index === 0 && request.originHeadingDegrees !== undefined
        ? { heading: Math.round(request.originHeadingDegrees) % 360, headingTolerance: 45 }
        : {}),
      ...(index === 0 && request.originHorizontalAccuracyMeters !== undefined
        ? {
            radius: Math.ceil(
              Math.min(100, Math.max(15, request.originHorizontalAccuracyMeters * 2)),
            ),
          }
        : {}),
    }),
  );
  // 3.8.2 does not parse a JSON pbf_field_selector. A binary request is required to ask for
  // directions AND trip (edge lanes/headings/shape speed annotations) in one upstream call.
  return ApiType.encode(
    ApiType.fromObject({
      options: {
        action: 1,
        alternates: request.alternatives,
        costingType: 10,
        costings: {
          10: {
            name: 'auto',
            type: 10,
            options: {
              excludeUnpaved: request.preferences.avoidUnpaved,
              useFerry: request.preferences.avoidFerries ? 0 : 0.5,
              useHighways: request.preferences.avoidHighways ? 0 : 0.5,
              useTolls: request.preferences.avoidTolls ? 0 : 0.5,
            },
          },
        },
        ...(request.alternatives === 0 ? { dateTimeType: 1, dateTime: 'current' } : {}),
        directionsType: 0,
        filterAction: 2,
        filterAttributes: ['shape_attributes.speed_limit'],
        format: 3,
        language: 'en-US',
        locations,
        pbfFieldSelector: { directions: true, trip: true, options: false },
        roundaboutExits: true,
        shapeFormat: 0,
        turnLanes: true,
        units: 0,
        voiceInstructions: true,
      },
    }),
  ).finish();
}
