import { useEffect, useState } from 'react';

import type { NativeHostStatus } from '../../../modules/navoss-navigation';
import { getHostStatus, observeHostStatus } from './native-navigation';

/** Android: whether prompts can be spoken and the trip is saved; both `true` on iOS. */
export function useHostStatus(): NativeHostStatus {
  const [status, setStatus] = useState(getHostStatus);
  useEffect(() => {
    const subscription = observeHostStatus(setStatus);
    setStatus(getHostStatus());
    return () => {
      subscription.remove();
    };
  }, []);
  return status;
}
