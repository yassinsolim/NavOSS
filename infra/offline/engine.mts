import pin from './routing-engine.lock.json' with { type: 'json' };

export function routingEnginePin(requested = pin.routingEngineVersion) {
  if (
    pin.schemaVersion !== 1 ||
    requested !== '3.9.1' ||
    pin.tileFormat !== 'valhalla-gph' ||
    !pin.image.startsWith(`ghcr.io/valhalla/valhalla-scripted:${requested}@`) ||
    requested !== pin.routingEngineVersion ||
    requested !== pin.mobileWrapper.routingEngineVersion ||
    requested !== pin.tileFormatVersion ||
    pin.mobileWrapper.version !== '0.6.4' ||
    pin.mobileWrapper.valhallaCommit !== 'bafb69902220615a48307d5c790fb6c943802ba4' ||
    !/^ghcr\.io\/valhalla\/valhalla-scripted:[0-9.]+@sha256:[0-9a-f]{64}$/.test(pin.image)
  ) {
    throw new Error(
      'Offline routing engine must match the engine embedded in pinned Rallista 0.6.4',
    );
  }
  return pin;
}
