import { buildApp } from './dist/app.js';
import { createProvincialRoadEventService } from './dist/provincial-road-events.js';
import { createProvincial511RoadEventFeed } from './dist/provincial-511-road-event-feed.js';
import { createEdmontonRoadEventFeed } from './dist/edmonton-road-event-feed.js';
import {
  createCalgaryConstructionRoadEventFeed,
  createCalgaryIncidentRoadEventFeed,
} from './dist/calgary-province-road-event-feed.js';
import { createDriveBcProvinceRoadEventFeed } from './dist/drivebc-province-road-event-feed.js';
import { createTorontoRoadEventFeed } from './dist/toronto-road-event-feed.js';
const provincialRoadEvents = createProvincialRoadEventService({
  alberta: [
    createProvincial511RoadEventFeed('alberta', undefined),
    createCalgaryIncidentRoadEventFeed(),
    createCalgaryConstructionRoadEventFeed(),
    createEdmontonRoadEventFeed({ dataUrl: 'http://127.0.0.1:9/dead' }),
  ],
  'british-columbia': [createDriveBcProvinceRoadEventFeed()],
  ontario: [createProvincial511RoadEventFeed('ontario', undefined), createTorontoRoadEventFeed()],
});
const app = await buildApp({ provincialRoadEvents, logger: false });
await app.listen({ host: '127.0.0.1', port: 3417 });
console.log('partial server listening');
