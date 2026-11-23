import { useEffect, useState } from 'react';

import { isSimulatingDrive, observeSimulatedDrive } from './native-navigation';

/** Whether a simulated drive (Android) is feeding the trip; always `false` on iOS. */
export function useSimulatedDrive(): boolean {
  const [active, setActive] = useState(isSimulatingDrive);
  useEffect(() => {
    const subscription = observeSimulatedDrive(setActive);
    setActive(isSimulatingDrive());
    return () => {
      subscription.remove();
    };
  }, []);
  return active;
}
