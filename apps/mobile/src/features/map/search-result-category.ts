import type { SearchResult } from '@navoss/contracts';

import { formatPlaceCategory } from './map-place';

const CATEGORY_ENUM_LABELS = {
  address: 'address',
  landmark: 'landmark',
  neighborhood: 'neighborhood',
  street: 'street',
} as const satisfies Record<Exclude<SearchResult['category'], 'poi'>, string>;

const MAX_CATEGORY_LABEL_WORDS = 3;

// Prefer a factual provider description. Format raw tags from older API deployments using the
// same presentation rules as tapped map places; omit placeholders instead of displaying jargon.
export function categoryLabel(item: SearchResult, activeCategoryLabel: string | undefined): string {
  if (item.category === 'street' || item.category === 'neighborhood') {
    return CATEGORY_ENUM_LABELS[item.category];
  }
  const detail = item.details?.category?.trim();
  const usableDetail =
    detail !== undefined &&
    detail.length > 0 &&
    !/^(?:yes|no|unknown|other|poi|point[ _-]of[ _-]interest|shop|amenity|building|house|commercial|residential|service|primary|secondary|tertiary|road|street)$/i.test(
      detail,
    )
      ? detail
      : undefined;
  if (!usableDetail && item.category !== 'poi') return CATEGORY_ENUM_LABELS[item.category];
  const source = usableDetail ?? activeCategoryLabel?.trim();
  if (!source) return '';
  return formatPlaceCategory(source)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_CATEGORY_LABEL_WORDS)
    .join(' ');
}
