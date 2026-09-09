// When one day stops being that day.
//
// A wedding does not end at midnight. Music ends at 00:00 and the site closes
// at 00:30, and both of those belong at the BOTTOM of Saturday's list, not the
// top of it — which is where they land the moment anything sorts "00:30"
// against "14:00" as text, or as a plain time.
//
// This is the same wrap-around that bit the curfew query in SQL, where
// `time + interval '24 hours'` quietly returns 00:30 again. The fix there was a
// minutes-past-midnight sort key; this is that key, for the two front ends.
//
// TWO O'CLOCK is the cutover, and it is a judgement rather than a fact: after
// the bar shuts at 23:45 and the site closes at 00:30, nothing legitimately
// happens between then and daybreak, so anything before 2am is still last
// night. A supplier arriving at 06:00 to set up is a genuine early start and
// sorts first, as it should.
export const DAY_ENDS_AT_MIN = 2 * 60;

// Minutes past midnight, with the small hours pushed onto the end of the day.
// Accepts "HH:MM" or "HH:MM:SS". Anything else sorts last.
//
// The range check is not decoration. "25:99" matches the shape of a time and
// arithmetic turns it into 1599 — a number that looks perfectly ordinary and
// would drop a nonsense row into the middle of the afternoon, where nobody
// would think to question it. Out of range belongs at the end with the rest of
// the unreadable input.
export function dayOrder(time) {
  if (!time) return Number.MAX_SAFE_INTEGER;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(time).trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  const h = Number(m[1]), min = Number(m[2]);
  if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) return Number.MAX_SAFE_INTEGER;
  const mins = h * 60 + min;
  return mins < DAY_ENDS_AT_MIN ? mins + 24 * 60 : mins;
}
