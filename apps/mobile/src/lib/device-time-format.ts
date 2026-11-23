// Formatters for times shown in the device's own time zone (arrival times, "updated 8:53 a.m.",
// draft dates), built once and reused.
//
// Reuse matters on Android: Hermes builds every `Intl.DateTimeFormat` through ICU in Java, which is
// slow enough to stall a render when it happens per call. But a formatter made without a `timeZone`
// option resolves the device's default zone when it is constructed, so a long-lived one keeps the
// zone the app started in: a driver crossing from Alberta into British Columbia would read arrival
// times in the old zone until the app is relaunched. So the cache is dropped when the device zone
// changes.
//
// The zone is detected from `Date` alone (no `Intl` construction, so it is cheap on Android):
// the UTC offsets of two fixed instants, one in January and one in July. A formatter is bound to
// its zone, not to an offset, so it applies each instant's own offset: a clock change between now
// and an arrival time, or a list of dates either side of one, formats correctly and shares one
// formatter. Only a different zone needs a rebuild. Two zones with the same January and July
// offsets but different names format these numeric and short-name outputs identically, so telling
// them apart is not needed and is not attempted. This is not for formats that print a zone name.

const WINTER_PROBE = Date.UTC(2026, 0, 15, 12);
const SUMMER_PROBE = Date.UTC(2026, 6, 15, 12);

function deviceZoneSignature(): string {
  return `${String(new Date(WINTER_PROBE).getTimezoneOffset())}/${String(new Date(SUMMER_PROBE).getTimezoneOffset())}`;
}

const formats = new Map<string, Intl.DateTimeFormat>();
let builtUnder = deviceZoneSignature();

/**
 * A formatter for `options` in the device's current time zone, reused until the zone changes.
 * `options` must not set `timeZone`: a formatter with an explicit zone does not depend on the
 * device and should be cached by that zone instead.
 */
export function deviceDateTimeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const signature = deviceZoneSignature();
  if (signature !== builtUnder) {
    formats.clear();
    builtUnder = signature;
  }
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, options);
    formats.set(key, format);
  }
  return format;
}
