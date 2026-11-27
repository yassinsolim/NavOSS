import {
  ProvincialRoadEventSchema,
  type ProvincialRoadEvent,
  type ProvincialRoadEventType,
} from '@navoss/contracts';
import { z } from 'zod/v4';

import {
  CONSTRUCTION_DATASET_ID,
  ConstructionRowSchema,
  coordinate,
  dataUrl,
  DatasetMetadataSchema,
  eventId,
  INCIDENT_DATASET_ID,
  IncidentRowSchema,
  NoIncidentRowSchema,
} from './calgary-road-event-provider.js';
import {
  createRoadEventFeed,
  normalizedText,
  parseLocalDateTime,
  truncate,
  type RoadEventFeed,
  type RoadEventFeedOptions,
  type RoadEventRoutingRow,
} from './official-road-event-feed.js';

/**
 * The two City of Calgary datasets behind `/v1/events`, presented in the provincial Alberta
 * response. Construction is official; current incidents stay unverified, as the City describes
 * them.
 */

const TIME_ZONE = 'America/Edmonton';
const LICENSE_URL = 'https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa';

/** `start_dt_utc` style text (`2026-11-13 04:42:51+00:00`) or floating Calgary wall time. */
function instant(local: string | undefined, utc: string | undefined): string | undefined {
  if (utc !== undefined) {
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?(?:Z|\+00:00)?$/u.exec(
      utc,
    );
    if (match === null) throw new Error('Invalid UTC timestamp.');
    const time = Date.parse(`${match[1] ?? ''}T${match[2] ?? ''}${match[3] ?? ''}Z`);
    if (!Number.isFinite(time)) throw new Error('Invalid UTC timestamp.');
    return new Date(time).toISOString();
  }
  if (local === undefined) return undefined;
  const time = parseLocalDateTime(local, TIME_ZONE);
  if (time === undefined) throw new Error('Invalid local timestamp.');
  return new Date(time).toISOString();
}

/** The City's description starts with its own kind of incident ("Stalled vehicle. …"). */
function incidentType(description: string): ProvincialRoadEventType {
  if (/^stalled vehicle\b/iu.test(description)) return 'stalled-vehicle';
  if (/^(?:collision|crash|multi-vehicle)\b/iu.test(description)) return 'collision';
  if (/^road closure\b/iu.test(description)) return 'closure';
  return 'incident';
}

const INCIDENT_LABELS: Readonly<Partial<Record<ProvincialRoadEventType, string>>> = {
  closure: 'Closure',
  collision: 'Collision',
  incident: 'Incident',
  'stalled-vehicle': 'Stalled vehicle',
};

export function normalizeCalgaryConstruction(input: unknown): ProvincialRoadEvent {
  const row = ConstructionRowSchema.parse(input);
  const location = normalizedText(row.construction_info);
  const description = normalizedText(row.description);
  const position = coordinate(row);
  const startsAt = instant(row.start_dt, row.start_dt_utc);
  let endsAt = instant(row.end_dt, row.end_dt_utc);
  if (startsAt !== undefined && endsAt !== undefined && endsAt < startsAt) endsAt = undefined;
  return ProvincialRoadEventSchema.parse({
    confidence: 'official',
    coordinate: position,
    description: truncate(description === '' ? location : description, 4_000),
    ...(endsAt === undefined ? {} : { endsAt }),
    id: eventId('calgary-construction', [location, description, startsAt, position]),
    regionId: 'alberta',
    roadwayName: truncate(location, 160),
    sourceId: 'calgary-construction-detours',
    ...(startsAt === undefined ? {} : { startsAt }),
    title: truncate(`Construction at ${location}`, 240),
    type: 'construction',
  });
}

export function normalizeCalgaryIncident(input: unknown): ProvincialRoadEvent | undefined {
  if (NoIncidentRowSchema.safeParse(input).success) return undefined;
  const row = IncidentRowSchema.parse(input);
  const location = normalizedText(row.incident_info);
  const description = normalizedText(row.description);
  const position = coordinate(row);
  const startsAt = instant(row.start_dt, row.start_dt_utc);
  const updatedAt = instant(row.modified_dt, row.modified_dt_utc);
  const type = incidentType(description);
  return ProvincialRoadEventSchema.parse({
    confidence: 'unverified',
    coordinate: position,
    description: truncate(description, 4_000),
    id: eventId('calgary-incident', [location, startsAt, position]),
    regionId: 'alberta',
    ...(startsAt === undefined ? {} : { reportedAt: startsAt, startsAt }),
    roadwayName: truncate(location, 160),
    sourceId: 'calgary-current-incidents',
    title: truncate(`${INCIDENT_LABELS[type] ?? 'Incident'} at ${location}`, 240),
    type,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  });
}

function calgaryFeed(
  construction: boolean,
  options: RoadEventFeedOptions & { dataUrl?: string; metadataUrl?: string },
): RoadEventFeed {
  const datasetId = construction ? CONSTRUCTION_DATASET_ID : INCIDENT_DATASET_ID;
  const rowsUrl = options.dataUrl ?? dataUrl(datasetId);
  const metadataUrl = options.metadataUrl ?? `https://data.calgary.ca/api/views/${datasetId}`;
  return createRoadEventFeed(
    {
      attribution:
        'Contains information licensed under the Open Government Licence \u2013 City of Calgary.',
      confidence: construction ? 'official' : 'unverified',
      documentationUrl: `https://data.calgary.ca/d/${datasetId}`,
      licenseUrl: LICENSE_URL,
      maximumAgeSeconds: construction ? 24 * 3_600 : 3_600,
      name: construction ? 'City of Calgary construction' : 'City of Calgary incidents',
      refreshIntervalSeconds: 300,
      sourceId: construction ? 'calgary-construction-detours' : 'calgary-current-incidents',
      timeZone: TIME_ZONE,
    },
    async ({ fetchJson }) => {
      const [data, metadata] = await Promise.all([fetchJson(rowsUrl), fetchJson(metadataUrl)]);
      const rows = z.array(z.unknown()).max(1_000).parse(data);
      const { rowsUpdatedAt } = DatasetMetadataSchema.parse(metadata);
      const events: ProvincialRoadEvent[] = [];
      const routingRows: RoadEventRoutingRow[] = [];
      let droppedRows = 0;
      let totalRows = 0;
      for (const row of rows) {
        if (!construction && NoIncidentRowSchema.safeParse(row).success) continue;
        totalRows += 1;
        try {
          const event = construction
            ? normalizeCalgaryConstruction(row)
            : normalizeCalgaryIncident(row);
          if (event !== undefined) {
            events.push(event);
            routingRows.push({ event, row });
          }
        } catch {
          droppedRows += 1;
        }
      }
      return {
        droppedRows,
        events,
        routingRows,
        totalRows,
        updatedAt: new Date(rowsUpdatedAt * 1_000).toISOString(),
      };
    },
    options,
  );
}

export function createCalgaryConstructionRoadEventFeed(
  options: RoadEventFeedOptions & { dataUrl?: string; metadataUrl?: string } = {},
): RoadEventFeed {
  return calgaryFeed(true, options);
}

export function createCalgaryIncidentRoadEventFeed(
  options: RoadEventFeedOptions & { dataUrl?: string; metadataUrl?: string } = {},
): RoadEventFeed {
  return calgaryFeed(false, options);
}
