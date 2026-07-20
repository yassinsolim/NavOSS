const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  alley: 'al',
  avenue: 'av',
  boulevard: 'bv',
  circle: 'ci',
  court: 'co',
  crescent: 'cr',
  drive: 'dr',
  east: 'e',
  highway: 'hy',
  lane: 'ln',
  northeast: 'ne',
  northwest: 'nw',
  parkway: 'py',
  place: 'pl',
  road: 'rd',
  southeast: 'se',
  southwest: 'sw',
  street: 'st',
  terrace: 'tc',
  trail: 'tr',
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
