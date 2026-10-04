/**
 * "00:00 America/New_York of a calendar date" as Unix seconds, DST-correct.
 * Eastern time is UTC-5 (EST) or UTC-4 (EDT); we try both offsets and keep the one
 * for which New York's wall clock really reads 00:00 on that date. Midnight is never
 * inside a DST gap in New York (transitions happen at 02:00), so exactly one matches.
 */
const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function nyWallClock(unixSeconds: number): string {
  const parts = Object.fromEntries(NY.formatToParts(new Date(unixSeconds * 1000)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** Returns null for a string that is not 'YYYY-MM-DD'. */
export function newYorkMidnight(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const utcMidnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  if (!Number.isFinite(utcMidnight)) return null;
  for (const offsetHours of [5, 4]) {
    const t = utcMidnight + offsetHours * 3600;
    if (nyWallClock(t) === `${date} 00:00`) return t;
  }
  return null;
}
