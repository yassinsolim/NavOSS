import { SearchCategorySchema } from '@navoss/contracts';

import { SEARCH_CATEGORY_TYPES } from '../dist/search-provider.js';

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

async function json(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { body, response };
}

const failures = [];
const calgary = [];
for (const [label, latitude, longitude] of calgaryPoints) {
  let nonempty = 0;
  const empty = [];
  for (const category of SearchCategorySchema.options) {
    const { body, response } = await json(`${baseUrl}/v1/search`, {
      body: JSON.stringify({
        category,
        includeDetails: true,
        latitude,
        limit: 8,
        longitude,
        q: category,
        sort: 'distance',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const results = body.results ?? [];
    const sorted = results.every(
      (result, index) =>
        index === 0 ||
        (result.distanceMeters ?? Number.POSITIVE_INFINITY) >=
          (results[index - 1]?.distanceMeters ?? -1),
    );
    const typesValid = results.every((result) =>
      SEARCH_CATEGORY_TYPES[category].has(result.details?.category),
    );
    const noBarbers =
      category !== 'bar' ||
      results.every((result) => !result.name.toLocaleLowerCase('en-CA').includes('barber'));
    if (!response.ok || !sorted || !typesValid || !noBarbers) {
      failures.push({ category, label, noBarbers, sorted, status: response.status, typesValid });
    }
    if (results.length === 0) empty.push(category);
    else nonempty += 1;
  }
  calgary.push({ empty, label, nonempty });
}

const { body: events, response: eventsResponse } = await json(
  `${baseUrl}/v2/events?region=ontario`,
);
if (!eventsResponse.ok || events.stale || events.source?.sourceId !== 'ontario-511-events') {
  failures.push({ endpoint: 'Ontario events', stale: events.stale, status: eventsResponse.status });
}
const ontario = ontarioCities.map(([city, latitude, longitude]) => {
  const distances = events.events
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
if (!camerasValid) failures.push({ endpoint: 'Toronto cameras', status: camerasResponse.status });

const { response: outsideSearchResponse } = await json(`${baseUrl}/v1/search`, {
  body: JSON.stringify({
    category: 'restaurant',
    latitude: 43.6532,
    limit: 8,
    longitude: -79.3832,
    q: 'restaurant',
    sort: 'distance',
  }),
  headers: { 'content-type': 'application/json' },
  method: 'POST',
});
if (outsideSearchResponse.status !== 400) {
  failures.push({ endpoint: 'Outside-coverage category', status: outsideSearchResponse.status });
}

console.log(
  JSON.stringify(
    {
      baseUrl,
      calgary,
      categoryCount: SearchCategorySchema.options.length,
      failures,
      ontario,
      ontarioEventCount: events.events?.length,
      torontoCameraCount: cameras.cameras?.length,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
