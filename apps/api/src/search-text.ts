import { CALGARY_STREET_TYPE_ALIASES } from './calgary-street-types.js';

const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  ...CALGARY_STREET_TYPE_ALIASES,
  east: 'e',
  northeast: 'ne',
  northwest: 'nw',
  southeast: 'se',
  southwest: 'sw',
  west: 'w',
};

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
