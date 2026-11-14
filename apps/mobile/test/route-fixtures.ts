import calgaryBreak from './fixtures/routes-v2/calgary-deerfoot-glenmore-break.v2.json';
import calgaryThrough from './fixtures/routes-v2/calgary-deerfoot-glenmore-through.v2.json';
import calgaryV1 from './fixtures/routes-v2/calgary-deerfoot-glenmore.v1.json';
import calgaryV2 from './fixtures/routes-v2/calgary-deerfoot-glenmore.v2.json';
import communityProtectedOrder from './fixtures/routes-v2/community-protected-order.v2.json';
import vancouverV2 from './fixtures/routes-v2/vancouver-bc91-highway99.v2.json';

/**
 * Route responses recorded from the NavOSS API, with the public development Valhalla or, for the
 * community-traffic order, a synthetic provider (see each file's `recorded` block). The same files back the Swift tests and the CarPlay harness.
 */
const RECORDINGS = {
  'calgary-deerfoot-glenmore-break.v2': calgaryBreak,
  'calgary-deerfoot-glenmore-through.v2': calgaryThrough,
  'calgary-deerfoot-glenmore.v1': calgaryV1,
  'calgary-deerfoot-glenmore.v2': calgaryV2,
  'community-protected-order.v2': communityProtectedOrder,
  'vancouver-bc91-highway99.v2': vancouverV2,
} as const;

export function recordedRoutes(name: keyof typeof RECORDINGS): unknown {
  return RECORDINGS[name].response;
}
