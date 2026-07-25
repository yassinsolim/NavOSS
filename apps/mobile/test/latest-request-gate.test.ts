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
