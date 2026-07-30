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
