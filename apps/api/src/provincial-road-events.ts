import {
  ProvincialRoadEventResponseSchema,
  type ProvincialRoadEvent,
  type ProvincialRoadEventRegion,
  type ProvincialRoadEventResponse,
} from '@navoss/contracts';

import {
  createCalgaryConstructionRoadEventFeed,
  createCalgaryIncidentRoadEventFeed,
} from './calgary-province-road-event-feed.js';
import { createDriveBcProvinceRoadEventFeed } from './drivebc-province-road-event-feed.js';
import { createEdmontonRoadEventFeed } from './edmonton-road-event-feed.js';
import type {
  RoadEventFeed,
  RoadEventFeedOptions,
  RoadEventFeedSnapshot,
} from './official-road-event-feed.js';
import { createProvincial511RoadEventFeed } from './provincial-511-road-event-feed.js';
import { createTorontoRoadEventFeed } from './toronto-road-event-feed.js';

export class ProvincialRoadEventsUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProvincialRoadEventsUnavailableError';
  }
}

export interface ProvincialRoadEventService {
  getRoadEvents(region: ProvincialRoadEventRegion): Promise<ProvincialRoadEventResponse>;
  /** Internal snapshots, including raw geometry/schedules; never serialized to clients. */
  getRoutingSnapshots(): Promise<readonly RoadEventFeedSnapshot[]>;
  start(): void;
  stop(): void;
}

export type ProvincialRoadEventFeeds = Readonly<
  Record<ProvincialRoadEventRegion, readonly RoadEventFeed[]>
>;

/**
 * Newest-first ordering key: the source's update, report or start instant, else its report or
 * start date (start of that day). A time after `ceiling` (the source's check time; a source clock
 * running ahead) counts as `ceiling`, so it cannot pin an event above genuinely newer ones. The phone uses the same key.
 */
export function roadEventRecency(event: ProvincialRoadEvent, ceiling: number): number {
  const instant = event.updatedAt ?? event.reportedAt ?? event.startsAt;
  const time = Date.parse(
    instant ?? `${event.reportedOn ?? event.startsOn ?? '0000-01-01'}T00:00:00.000Z`,
  );
  return Math.min(time, ceiling);
}

export function createProvincialRoadEventService(
  feeds: ProvincialRoadEventFeeds,
  clock: () => number = Date.now,
): ProvincialRoadEventService {
  return {
    getRoutingSnapshots() {
      return Promise.all(
        Object.values(feeds).flatMap((region) => region.map((feed) => feed.getSnapshot())),
      );
    },
    async getRoadEvents(region) {
      const snapshots = await Promise.all(feeds[region].map((feed) => feed.getSnapshot()));
      const sources = snapshots.map((snapshot) => snapshot.source);
      if (!sources.some((source) => source.status === 'current' || source.status === 'stale')) {
        throw new ProvincialRoadEventsUnavailableError(
          `No ${region} road-event source is available.`,
        );
      }
      const now = clock();
      const events = snapshots
        .flatMap(({ events: sourceEvents, source }) => {
          // Cap at the snapshot's own check time, as the phone does: a retained stale copy
          // must not gain recency with every later response.
          const ceiling = source.checkedAt === undefined ? now : Date.parse(source.checkedAt);
          return sourceEvents.map((event) => ({
            event,
            recency: roadEventRecency(event, ceiling),
          }));
        })
        .sort((left, right) =>
          left.recency === right.recency
            ? left.event.id.localeCompare(right.event.id, 'en-CA')
            : right.recency - left.recency,
        )
        .map(({ event }) => event);
      return ProvincialRoadEventResponseSchema.parse({
        degraded: sources.some((source) => source.status !== 'current' || source.incomplete),
        events,
        generatedAt: new Date(now).toISOString(),
        regionId: region,
        sources,
        stale: sources.some((source) => source.status === 'stale'),
      });
    },
    start() {
      for (const feed of Object.values(feeds).flat()) feed.start();
    },
    stop() {
      for (const feed of Object.values(feeds).flat()) feed.stop();
    },
  };
}

/**
 * `ALBERTA_511_API_KEY` and `ONTARIO_511_API_KEY`: developer keys for the 511 event APIs. Both are
 * optional; an absent or empty key leaves that feed `not-configured`.
 */
export function roadEventKeysFromEnvironment(environment: NodeJS.ProcessEnv = process.env): {
  alberta511ApiKey?: string;
  ontario511ApiKey?: string;
} {
  const alberta = environment.ALBERTA_511_API_KEY?.trim();
  const ontario = environment.ONTARIO_511_API_KEY?.trim();
  return {
    ...(alberta === undefined || alberta === '' ? {} : { alberta511ApiKey: alberta }),
    ...(ontario === undefined || ontario === '' ? {} : { ontario511ApiKey: ontario }),
  };
}

/** Production wiring. Keyed 511 feeds stay inert without their keys. */
export function createDefaultProvincialRoadEventFeeds(
  keys: { alberta511ApiKey?: string; ontario511ApiKey?: string },
  options: RoadEventFeedOptions = {},
): ProvincialRoadEventFeeds {
  return {
    alberta: [
      createProvincial511RoadEventFeed('alberta', keys.alberta511ApiKey, options),
      createCalgaryIncidentRoadEventFeed(options),
      createCalgaryConstructionRoadEventFeed(options),
      createEdmontonRoadEventFeed(options),
    ],
    'british-columbia': [createDriveBcProvinceRoadEventFeed(options)],
    ontario: [
      createProvincial511RoadEventFeed('ontario', keys.ontario511ApiKey, options),
      createTorontoRoadEventFeed(options),
    ],
  };
}
