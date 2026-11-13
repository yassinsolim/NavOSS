import { normalizeSearchText } from './search-text.js';

export interface SearchLocation {
  city?: string;
  houseNumber?: string;
  street?: string;
  streetAddress?: string;
  subtitle: string;
  unit?: string;
}

const POSTAL_CODE = /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/iu;
const STREET_WORD =
  /\b(?:street|st|avenue|ave?|drive|dr|trail|tr|road|rd|boulevard|blvd|bv|gate|ga|common|circle|cir|way|highway|hwy|crescent|cres|place|pl|lane|ln|court|ct|terrace|ter|link|li)\b/iu;
const ADMINISTRATIVE_BREADCRUMB =
  /^(?:regional district of|town of|city of|westbank first nation|improvement district|area [a-z]\b)|\belectoral area$/iu;
const OMITTED_LOCALITY: Record<string, true> = {
  canada: true,
  ca: true,
  alberta: true,
  ab: true,
  'british columbia': true,
  bc: true,
};

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Prefer structured provider addresses; the breadcrumb fallback also supports older providers. */
export function searchLocation(
  name: string,
  label: string,
  address: Readonly<Record<string, string | undefined>> = {},
): SearchLocation {
  const normalizedName = normalizeSearchText(name);
  const parts = label
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (normalizeSearchText(parts[0] ?? '') === normalizedName) parts.shift();
  const localParts = parts.filter(
    (part) =>
      OMITTED_LOCALITY[part.toLocaleLowerCase('en-CA')] !== true &&
      !POSTAL_CODE.test(part) &&
      !ADMINISTRATIVE_BREADCRUMB.test(part),
  );
  const first = localParts[0];
  const second = localParts[1];
  const breadcrumbAddress =
    first !== undefined && /^\d+[\p{L}\d/-]*$/u.test(first) && second !== undefined
      ? `${first} ${second}`
      : first !== undefined && STREET_WORD.test(first)
        ? first
        : undefined;
  const road = text(address.road ?? address.pedestrian ?? address.footway ?? address.path);
  let houseNumber = text(address.house_number);
  const normalizedNumber = houseNumber === undefined ? undefined : normalizeSearchText(houseNumber);
  const roadIncludesNumber =
    road !== undefined &&
    normalizedNumber !== undefined &&
    normalizeSearchText(road).startsWith(`${normalizedNumber} `);
  let streetAddress =
    road === undefined
      ? breadcrumbAddress
      : roadIncludesNumber
        ? road
        : [houseNumber, road].filter(Boolean).join(' ');
  // Address results often repeat the entire civic address as their name.
  const namedAddress =
    /^\s*(?:#[\p{L}\d/-]+\s+)?\d/u.test(name) && STREET_WORD.test(name) ? name : undefined;
  streetAddress ??= namedAddress;
  const civic = streetAddress?.match(/^(?:#([\p{L}\d/-]+)\s+)?(\d+[\p{L}\d/-]*)\s+(.+)$/u);
  houseNumber ??= civic?.[2];
  const street = civic?.[3] ?? road ?? streetAddress;
  const last = localParts.at(-1);
  const city =
    text(
      address.city ?? address.town ?? address.village ?? address.hamlet ?? address.municipality,
    ) ?? (last !== undefined && !STREET_WORD.test(last) && !/^\d/u.test(last) ? last : undefined);
  const neighborhood =
    text(address.neighbourhood ?? address.suburb ?? address.quarter ?? address.city_district) ??
    (streetAddress === undefined ? first : undefined);
  const context = streetAddress ?? neighborhood;
  const subtitle = [context, city]
    .filter(
      (part): part is string => part !== undefined && normalizeSearchText(part) !== normalizedName,
    )
    .filter(
      (part, index, values) =>
        values.findIndex((value) => normalizeSearchText(value) === normalizeSearchText(part)) ===
        index,
    )
    .join(', ');
  return {
    ...(city === undefined ? {} : { city }),
    ...(houseNumber === undefined ? {} : { houseNumber }),
    ...(street === undefined ? {} : { street }),
    ...(streetAddress === undefined ? {} : { streetAddress }),
    subtitle,
    ...(civic?.[1] === undefined ? {} : { unit: civic[1] }),
  };
}

/** Only unambiguous legal/designator variants, never arbitrary name prefixes or departments. */
export function canonicalSearchName(name: string): string {
  return normalizeSearchText(name.replace(/\s+#\d{2,}\s*$/u, ''))
    .replace(/(?: (?:inc|incorporated|ltd|limited|llc|corp|corporation))+$/u, '')
    .replace(/ wholesale$/u, '');
}

/** Confidence is query-specific name relevance, not a provider's importance or result position. */
export function searchNameConfidence(
  name: string,
  label: string,
  query: string,
  providerConfidence: number,
): number {
  const wanted = normalizeSearchText(query);
  const normalizedName = normalizeSearchText(name);
  const canonicalName = canonicalSearchName(name);
  if (wanted === normalizedName || canonicalSearchName(query) === canonicalName) return 0.98;
  const normalizedLabel = normalizeSearchText(label);
  const labelWords = normalizedLabel.split(' ');
  // A name qualified by a locality/address ("Costco Kelowna") is an explicit place request.
  if (
    wanted.startsWith(`${canonicalName} `) &&
    wanted.split(' ').every((word) => labelWords.includes(word))
  )
    return 0.98;
  if (normalizedName.startsWith(wanted) || canonicalName.startsWith(wanted)) return 0.94;
  const words = wanted.split(' ');
  const nameWords = normalizedName.split(' ');
  if (words.every((word) => nameWords.some((candidate) => candidate.startsWith(word)))) return 0.88;
  if (normalizedName.includes(wanted)) return 0.84;
  if (words.every((word) => normalizedLabel.includes(word))) return 0.72;
  return Math.min(providerConfidence, 0.6);
}
