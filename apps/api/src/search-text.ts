import { CALGARY_STREET_TYPE_ALIASES } from './calgary-street-types.js';

const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  ...CALGARY_STREET_TYPE_ALIASES,
  east: 'e',
  northeast: 'ne',
  northwest: 'nw',
  southeast: 'se',
  southwest: 'sw',
  // Quebec abbreviates the saint in street names ("rue Ste-Catherine").
  ste: 'sainte',
  west: 'w',
};

/** Normalised tokens that end a street name with its direction or quadrant. */
export const STREET_DIRECTION_TOKENS: Readonly<Record<string, true>> = {
  e: true,
  est: true,
  n: true,
  ne: true,
  nord: true,
  north: true,
  nw: true,
  ouest: true,
  s: true,
  se: true,
  south: true,
  sud: true,
  sw: true,
  w: true,
};
// French names lead with the generic ("rue Sainte-Catherine"), English names end with it
// ("Yonge Street"); both as normalised tokens, so "street" is "st" and "avenue" is "av".
const FRENCH_STREET_GENERICS: Readonly<Record<string, true>> = {
  allee: true,
  av: true,
  boul: true,
  bv: true,
  chemin: true,
  cote: true,
  montee: true,
  rang: true,
  route: true,
  rue: true,
};
const ENGLISH_STREET_TYPES: Readonly<Record<string, true>> = {
  av: true,
  bv: true,
  ci: true,
  co: true,
  cr: true,
  dr: true,
  ga: true,
  hi: true,
  line: true,
  ln: true,
  pl: true,
  py: true,
  rd: true,
  sideroad: true,
  sq: true,
  st: true,
  tc: true,
  tr: true,
  wy: true,
};

/**
 * Directional names of the street a query names without its direction. Nominatim returns only
 * full-name matches once any exist, so "rue Sainte-Catherine" finds the suburbs' streets of that
 * exact name and never Montréal's "Rue Sainte-Catherine Ouest", and "Queen Street" never finds
 * Toronto's "Queen Street West". Empty unless the query ends with an English street type or
 * starts (after any house number) with a French generic, and does not already give a direction.
 */
export function streetDirectionVariants(value: string): string[] {
  const original = value.trim().replace(/\s+/gu, ' ');
  const tokens = normalizeSearchText(original).split(' ').filter(Boolean);
  const last = tokens.at(-1);
  if (tokens.length < 2 || last === undefined || STREET_DIRECTION_TOKENS[last] === true) return [];
  const generic = tokens[/^\d/u.test(tokens[0] ?? '') ? 1 : 0] ?? '';
  const directions =
    FRENCH_STREET_GENERICS[generic] === true
      ? ['Ouest', 'Est', 'Nord', 'Sud']
      : ENGLISH_STREET_TYPES[last] === true
        ? ['West', 'East', 'North', 'South']
        : [];
  return directions.map((direction) => `${original} ${direction}`);
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-CA')
    .replace(/&/g, ' and ')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .map((token) => TOKEN_ALIASES[token] ?? token)
    .join(' ');
}

export function prefixTsQuery(value: string): string {
  return normalizeSearchText(value)
    .split(' ')
    .filter((token) => token.length > 0)
    .map((token) => `${token}:*`)
    .join(' & ');
}

export function placeSearchQueryVariants(value: string): string[] {
  const original = value.trim();
  const theatreSpelling = original.replace(/\btheaters?\b/giu, (match) =>
    match.toLocaleLowerCase('en-CA').endsWith('s') ? 'theatres' : 'theatre',
  );
  const genericTheatre = theatreSpelling.replace(/\bcineplex\b/giu, 'theatre');
  return [...new Set([original, theatreSpelling, genericTheatre].filter(Boolean))];
}
