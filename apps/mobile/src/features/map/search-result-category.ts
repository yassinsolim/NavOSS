import type { SearchResult } from '@navoss/contracts';

import { formatPlaceCategory } from './map-place';
import { searchResultContext } from './search-proximity';

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
    .replace(/^Lrt\b/u, 'LRT')
    .replace(/^Atm\b/u, 'ATM')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_CATEGORY_LABEL_WORDS)
    .join(' ');
}

/** Keep older API breadcrumbs readable too; current providers already send compact labels. */
export function searchResultSubtitle(item: SearchResult): string {
  const context = searchResultContext(item);
  if (context === item.name) return '';
  const parts = context
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const visible = parts.filter(
    (part) =>
      !/^(?:Canada|CA|Alberta|AB|British Columbia|BC)$/iu.test(part) &&
      !/^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/iu.test(part) &&
      !/^(?:Regional District of|Town of|City of|Westbank First Nation|Improvement District|Area [A-Z]\b)|\belectoral area$/iu.test(
        part,
      ),
  );
  const first = visible[0];
  if (first === undefined) return '';
  const address =
    /^\d+[\p{L}\d/-]*$/u.test(first) && visible[1] !== undefined ? `${first} ${visible[1]}` : first;
  const city = visible.at(-1);
  return city === undefined || city === address || (city === visible[1] && address !== first)
    ? address
    : `${address}, ${city}`;
}
