interface CalgaryStreetType {
  aliases: readonly string[];
  label: string;
}

export const CALGARY_STREET_TYPES = {
  AL: { aliases: ['alley'], label: 'Alley' },
  AV: { aliases: ['ave', 'avenue'], label: 'Avenue' },
  BA: { aliases: ['bay'], label: 'Bay' },
  BV: { aliases: ['blvd', 'boulevard'], label: 'Boulevard' },
  CA: { aliases: ['cape'], label: 'Cape' },
  CE: { aliases: ['center', 'centre'], label: 'Centre' },
  CI: { aliases: ['cir', 'circle'], label: 'Circle' },
  CL: { aliases: ['close'], label: 'Close' },
  CM: { aliases: ['common'], label: 'Common' },
  CO: { aliases: ['court', 'ct'], label: 'Court' },
  CR: { aliases: ['cres', 'crescent'], label: 'Crescent' },
  CV: { aliases: ['cove'], label: 'Cove' },
  DR: { aliases: ['drive'], label: 'Drive' },
  GA: { aliases: ['gate'], label: 'Gate' },
  GD: { aliases: ['garden', 'gardens'], label: 'Gardens' },
  GR: { aliases: ['green'], label: 'Green' },
  GV: { aliases: ['grove'], label: 'Grove' },
  HE: { aliases: ['heath'], label: 'Heath' },
  HI: { aliases: ['highway', 'hwy'], label: 'Highway' },
  HL: { aliases: ['hill'], label: 'Hill' },
  HT: { aliases: ['height', 'heights', 'hts'], label: 'Heights' },
  IS: { aliases: ['island'], label: 'Island' },
  LD: { aliases: ['landing'], label: 'Landing' },
  LI: { aliases: ['link'], label: 'Link' },
  LN: { aliases: ['lane'], label: 'Lane' },
  ME: { aliases: ['mews'], label: 'Mews' },
  MR: { aliases: ['manor'], label: 'Manor' },
  MT: { aliases: ['mount'], label: 'Mount' },
  PA: { aliases: ['park'], label: 'Park' },
  PH: { aliases: ['path'], label: 'Path' },
  PL: { aliases: ['place'], label: 'Place' },
  PR: { aliases: ['parade'], label: 'Parade' },
  PS: { aliases: ['passage'], label: 'Passage' },
  PT: { aliases: ['point'], label: 'Point' },
  PY: { aliases: ['parkway', 'pkwy'], label: 'Parkway' },
  PZ: { aliases: ['plaza'], label: 'Plaza' },
  RD: { aliases: ['road'], label: 'Road' },
  RI: { aliases: ['rise'], label: 'Rise' },
  RO: { aliases: ['row'], label: 'Row' },
  SQ: { aliases: ['square'], label: 'Square' },
  ST: { aliases: ['street'], label: 'Street' },
  TC: { aliases: ['terr', 'terrace'], label: 'Terrace' },
  TR: { aliases: ['trail'], label: 'Trail' },
  VI: { aliases: ['villa', 'villas'], label: 'Villas' },
  VW: { aliases: ['view'], label: 'View' },
  WK: { aliases: ['walk'], label: 'Walk' },
  WY: { aliases: ['way'], label: 'Way' },
} as const satisfies Readonly<Record<string, CalgaryStreetType>>;

export function calgaryStreetTypeLabel(code: string): string | undefined {
  return (CALGARY_STREET_TYPES as Readonly<Record<string, CalgaryStreetType>>)[code.toUpperCase()]
    ?.label;
}

export const CALGARY_STREET_TYPE_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CALGARY_STREET_TYPES).flatMap(([code, streetType]) =>
    [code.toLocaleLowerCase('en-CA'), ...streetType.aliases].map((alias) => [
      alias,
      code.toLocaleLowerCase('en-CA'),
    ]),
  ),
);
