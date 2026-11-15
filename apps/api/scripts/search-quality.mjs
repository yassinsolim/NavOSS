import { setTimeout as delay } from 'node:timers/promises';

import { SearchCategorySchema, SearchResponseSchema } from '@navoss/contracts';

import { judgeCategoryResults, judgeOntarioEvents } from '../dist/search-quality-judge.js';

const baseUrl = (process.env.NAVOSS_BASE_URL ?? 'https://navoss-api.yassin.app').replace(
  /\/$/u,
  '',
);
const calgaryPoints = [
  ['Downtown', 51.0447, -114.0719],
  ['Aspen Woods', 51.045, -114.205],
  ['Bowness', 51.087, -114.2],
  ['University', 51.08, -114.13],
  ['Sage Hill', 51.17, -114.14],
  ['Skyview Ranch', 51.16, -113.96],
  ['Airport industrial', 51.12, -114],
  ['Forest Lawn', 51.04, -113.97],
  ['Lake Bonavista', 50.94, -114.05],
  ['Shawnessy', 50.9, -114.07],
  ['Mahogany', 50.9, -113.95],
  ['Seton', 50.87, -113.96],
];
const kelownaPoints = [
  ['Downtown Kelowna', 49.8879, -119.496],
  ['Rutland', 49.891, -119.386],
  ['Lower Mission', 49.835, -119.489],
  ['Kelowna Airport', 49.9561, -119.378],
  ['West Kelowna', 49.8625, -119.583],
];
const canadaPoints = [
  ['Toronto', 43.6532, -79.3832, 'ontario'],
  ['Montreal', 45.5088, -73.554, 'quebec'],
  ['Halifax', 44.6488, -63.5752, 'nova-scotia'],
  ['Winnipeg', 49.8954, -97.1385, 'manitoba'],
];
const kelownaRequiredCategories = new Set([
  'cafe',
  'charging-station',
  'fuel',
  'grocery',
  'healthcare',
  'hotel',
  'park',
  'parking',
  'pharmacy',
  'restaurant',
]);
const ontarioCities = [
  ['Toronto', 43.6532, -79.3832],
  ['Mississauga', 43.589, -79.6441],
  ['Hamilton', 43.2557, -79.8711],
  ['Kitchener-Waterloo', 43.4516, -80.4925],
  ['London', 42.9849, -81.2453],
  ['Windsor', 42.3149, -83.0364],
  ['Ottawa', 45.4215, -75.6972],
  ['Kingston', 44.2312, -76.486],
  ['Sudbury', 46.4917, -80.993],
  ['Thunder Bay', 48.3809, -89.2477],
];

function distanceKilometers(left, right) {
  const radians = Math.PI / 180;
  const latitudeDelta = (right[0] - left[0]) * radians;
  const longitudeDelta = (right[1] - left[1]) * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(left[0] * radians) * Math.cos(right[0] * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * 6_371 * Math.asin(Math.sqrt(haversine));
}

let lastRequestStarted = 0;
let requestCount = 0;
async function json(url, options) {
  const wait = Math.max(0, 550 - (Date.now() - lastRequestStarted));
  if (wait > 0) await delay(wait);
  lastRequestStarted = Date.now();
  requestCount += 1;
  const response = await fetch(url, options);
  const body = await response.json();
  return { body, response };
}

const failures = [];
const calgary = [];
const kelowna = [];
const canada = [];
const kelownaCategoriesPresent = new Set();
for (const [label, latitude, longitude, province] of [
  ...calgaryPoints,
  ...kelownaPoints.map((point) => [...point, 'british-columbia']),
  ...canadaPoints,
]) {
  const isKelowna = province === 'british-columbia';
  let nonempty = 0;
  const empty = [];
  for (const category of SearchCategorySchema.options) {
    const query = {
      category,
      includeDetails: true,
      latitude,
      limit: 8,
      longitude,
      q: category,
      sort: 'distance',
    };
    const { body, response } = await json(`${baseUrl}/v1/search`, {
      body: JSON.stringify(query),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const parsed = SearchResponseSchema.safeParse(body);
    const results = parsed.success ? parsed.data.results : [];
    const checks = judgeCategoryResults(
      category,
      results,
      parsed.success ? parsed.data.source : undefined,
      province,
    );
    if (!response.ok || !parsed.success || Object.values(checks).some((valid) => !valid)) {
      failures.push({
        category,
        label,
        query,
        ...checks,
        responseValid: parsed.success,
        status: response.status,
        source: body.source,
        rows: body.results,
        ...(parsed.success ? {} : { response: body }),
      });
    }
    if (results.length === 0) empty.push(category);
    else {
      nonempty += 1;
      if (isKelowna) kelownaCategoriesPresent.add(category);
    }
  }
  const summary = { empty, label, latitude, longitude, nonempty };
  if (isKelowna) kelowna.push(summary);
  else if (province === undefined) calgary.push(summary);
  else canada.push(summary);
  if (province !== undefined && nonempty < 20) {
    failures.push({
      endpoint: 'Regional category coverage',
      label,
      latitude,
      longitude,
      nonempty,
      empty,
    });
  }
}
for (const category of kelownaRequiredCategories) {
  if (!kelownaCategoriesPresent.has(category)) {
    failures.push({ category, endpoint: 'Kelowna essential category coverage' });
  }
}

const { body: events, response: eventsResponse } = await json(
  `${baseUrl}/v2/events?region=ontario`,
);
const eventChecks = judgeOntarioEvents(events);
if (!eventsResponse.ok || Object.values(eventChecks).some((valid) => !valid)) {
  failures.push({
    endpoint: 'Ontario events',
    ...eventChecks,
    stale: events.stale,
    sources: events.sources,
    status: eventsResponse.status,
  });
}
const ontario = ontarioCities.map(([city, latitude, longitude]) => {
  const distances = (events.events ?? [])
    .map((event) =>
      distanceKilometers(
        [latitude, longitude],
        [event.coordinate.latitude, event.coordinate.longitude],
      ),
    )
    .sort((left, right) => left - right);
  return {
    city,
    nearestKilometers: Number((distances[0] ?? Number.POSITIVE_INFINITY).toFixed(1)),
    within50Kilometers: distances.filter((distance) => distance <= 50).length,
  };
});

const { body: cameras, response: camerasResponse } = await json(
  `${baseUrl}/v2/cameras?region=toronto-on`,
);
const camerasValid =
  camerasResponse.ok &&
  cameras.cameras?.length > 0 &&
  cameras.cameras.every(
    (camera) =>
      camera.coordinate.latitude >= 43.58 &&
      camera.coordinate.latitude <= 43.86 &&
      camera.coordinate.longitude >= -79.64 &&
      camera.coordinate.longitude <= -79.1,
  );
if (!camerasValid)
  failures.push({
    endpoint: 'Toronto cameras',
    status: camerasResponse.status,
    rows: cameras.cameras,
  });

const outsideQuery = {
  category: 'restaurant',
  latitude: 47.6062,
  limit: 8,
  longitude: -122.3321,
  q: 'restaurant',
  sort: 'distance',
};
const { body: outsideBody, response: outsideSearchResponse } = await json(`${baseUrl}/v1/search`, {
  body: JSON.stringify(outsideQuery),
  headers: { 'content-type': 'application/json' },
  method: 'POST',
});
if (outsideSearchResponse.status !== 400) {
  failures.push({
    endpoint: 'Outside-coverage category',
    query: outsideQuery,
    status: outsideSearchResponse.status,
    response: outsideBody,
  });
}

console.log(
  JSON.stringify(
    {
      baseUrl,
      calgary,
      canada,
      categoryCount: SearchCategorySchema.options.length,
      failures,
      kelowna,
      ontario,
      ontarioEventCount: events.events?.length,
      ontarioSources: events.sources,
      requestCount,
      torontoCameraCount: cameras.cameras?.length,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
