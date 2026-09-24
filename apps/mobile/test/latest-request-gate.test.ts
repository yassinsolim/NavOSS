import { describe, expect, it } from 'vitest';

import { createLatestRequestGate } from '../src/features/map/latest-request-gate.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('latest request gate', () => {
  it('rejects a deferred category response after newer search intent begins', async () => {
    const gate = createLatestRequestGate();
    const cafeResponse = deferred<string>();
    const restaurantResponse = deferred<string>();
    const appliedResults: string[] = [];

    const cafeGeneration = gate.advance();
    const cafeCompletion = cafeResponse.promise.then((result) => {
      if (gate.isCurrent(cafeGeneration)) appliedResults.push(result);
    });

    const restaurantGeneration = gate.advance();
    const restaurantCompletion = restaurantResponse.promise.then((result) => {
      if (gate.isCurrent(restaurantGeneration)) appliedResults.push(result);
    });

    restaurantResponse.resolve('Restaurants');
    await restaurantCompletion;
    cafeResponse.resolve('Coffee');
    await cafeCompletion;

    expect(appliedResults).toEqual(['Restaurants']);
  });
});

// map-screen's handleMapPress reserves a single interaction token via this same gate before its
// first native queryRenderedFeatures await, then re-checks isCurrent() after every awaited
// camera/road-event/POI hit test and before presenting an alert or applying a selection. These
// cases model that sequencing directly, without rendering the map screen.
describe('map tap interaction gate (camera/road-event/POI hit-testing)', () => {
  it('suppresses a stale camera alert once a newer interaction begins mid hit-test', async () => {
    const gate = createLatestRequestGate();
    const cameraQuery = deferred<{ hasCamera: boolean }>();
    const alertsShown: string[] = [];

    const tapGeneration = gate.advance();
    const tapCompletion = cameraQuery.promise.then((result) => {
      if (!gate.isCurrent(tapGeneration)) return;
      if (result.hasCamera) alertsShown.push('camera-alert');
    });

    // A newer interaction (selecting elsewhere, or clearing the sheet) begins while this tap's
    // native hit-test is still pending.
    gate.advance();

    cameraQuery.resolve({ hasCamera: true });
    await tapCompletion;

    expect(alertsShown).toEqual([]);
  });

  it('never mints a fresh token at the POI fallback, so a deferred old tap cannot overwrite a newer selection', async () => {
    const gate = createLatestRequestGate();
    const cameraQuery = deferred<{ hasCamera: boolean }>();
    const roadEventQuery = deferred<{ hasEvent: boolean }>();
    const poiQuery = deferred<{ placeId: string } | undefined>();
    let selectedPlaceId: string | undefined;

    // Old tap reserves its token once, up front, mirroring handleMapPress.
    const oldTapGeneration = gate.advance();
    const oldTapCompletion = (async () => {
      const cameraResult = await cameraQuery.promise;
      if (!gate.isCurrent(oldTapGeneration) || cameraResult.hasCamera) return;
      const roadEventResult = await roadEventQuery.promise;
      if (!gate.isCurrent(oldTapGeneration) || roadEventResult.hasEvent) return;
      const place = await poiQuery.promise;
      if (!gate.isCurrent(oldTapGeneration) || place === undefined) return;
      selectedPlaceId = place.placeId;
    })();

    // The old tap's camera and road-event hit tests come back empty, falling through toward the
    // POI branch, but a newer interaction (selecting a search result, or clearing) lands and
    // applies its own selection before the old tap's POI query resolves.
    cameraQuery.resolve({ hasCamera: false });
    roadEventQuery.resolve({ hasEvent: false });
    selectedPlaceId = 'new-selection';
    gate.advance();

    poiQuery.resolve({ placeId: 'old-tapped-poi' });
    await oldTapCompletion;

    expect(selectedPlaceId).toBe('new-selection');
  });

  it('still applies the POI selection when no newer interaction interrupts the tap', async () => {
    const gate = createLatestRequestGate();
    const cameraQuery = deferred<{ hasCamera: boolean }>();
    const roadEventQuery = deferred<{ hasEvent: boolean }>();
    const poiQuery = deferred<{ placeId: string } | undefined>();
    let selectedPlaceId: string | undefined;

    const tapGeneration = gate.advance();
    const tapCompletion = (async () => {
      const cameraResult = await cameraQuery.promise;
      if (!gate.isCurrent(tapGeneration) || cameraResult.hasCamera) return;
      const roadEventResult = await roadEventQuery.promise;
      if (!gate.isCurrent(tapGeneration) || roadEventResult.hasEvent) return;
      const place = await poiQuery.promise;
      if (!gate.isCurrent(tapGeneration) || place === undefined) return;
      selectedPlaceId = place.placeId;
    })();

    cameraQuery.resolve({ hasCamera: false });
    roadEventQuery.resolve({ hasEvent: false });
    poiQuery.resolve({ placeId: 'tapped-poi' });
    await tapCompletion;

    expect(selectedPlaceId).toBe('tapped-poi');
  });
});
