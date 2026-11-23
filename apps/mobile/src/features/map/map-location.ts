interface ForegroundPermission {
  canAskAgain: boolean;
  granted: boolean;
}

export async function ensureForegroundLocationPermission(
  getPermission: () => Promise<ForegroundPermission>,
  requestPermission: () => Promise<ForegroundPermission>,
): Promise<boolean> {
  const permission = await getPermission();
  if (permission.granted) return true;
  if (!permission.canAskAgain) return false;
  return (await requestPermission()).granted;
}

/**
 * The map's own permission request: the system prompt at most once per app session. Android
 * pauses the app behind the permission dialog, so the map becomes visible again as soon as the
 * driver answers and would ask again at once (Android's second dialog offers "Don't allow" as
 * "don't ask again"). Later calls only read the permission, so a grant made in Settings is still
 * seen. Explicit actions (Center, Directions) keep asking through `ensureForegroundLocationPermission`.
 */
export function createAutomaticLocationPermission(
  getPermission: () => Promise<ForegroundPermission>,
  requestPermission: () => Promise<ForegroundPermission>,
): () => Promise<boolean> {
  let prompted = false;
  return () =>
    ensureForegroundLocationPermission(getPermission, () => {
      if (prompted) return getPermission();
      prompted = true;
      return requestPermission();
    });
}
