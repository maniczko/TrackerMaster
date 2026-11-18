import { Temporal } from "@js-temporal/polyfill";

// Executable TECH-09 reference contract. Not connected to SQLite or production UI.
const NS_PER_SECOND = 1_000_000_000n;
const anchor = Temporal.Instant.from("2000-01-01T00:00:00Z");

function instant(value, label) {
  if (typeof value !== "string") throw new TypeError(label + " must be a UTC instant string");
  const parsed = Temporal.Instant.from(value);
  if (parsed.epochNanoseconds % NS_PER_SECOND !== 0n) {
    throw new RangeError(label + " must have whole-second precision");
  }
  return parsed;
}

function seconds(start, end) {
  const delta = end.epochNanoseconds - start.epochNanoseconds;
  if (delta <= 0n || delta % NS_PER_SECOND !== 0n) {
    throw new RangeError("Time interval must have positive whole-second duration");
  }
  const value = Number(delta / NS_PER_SECOND);
  if (!Number.isSafeInteger(value)) throw new RangeError("Duration exceeds safe integer");
  return value;
}

function timezone(value) {
  if (typeof value !== "string" || !value) throw new TypeError("IANA timezone is required");
  anchor.toZonedDateTimeISO(value);
  return value;
}

function localDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError("Local date must use YYYY-MM-DD");
  }
  return Temporal.PlainDate.from(value).toString();
}

// Caller must explicitly provide eligibleIntervals if any sleep is unresolved.
// No implicit acceptance or inference from original start/end timestamps is allowed.
export function segmentCompletedEntry(entry, reportTimezone) {
  const zone = timezone(reportTimezone);
  if (!entry || typeof entry !== "object") throw new TypeError("Entry is required");
  if (entry.state !== "completed") {
    if (entry.state === "running" || entry.state === "unresolved") return [];
    throw new RangeError("Unknown entry state");
  }
  for (const field of ["entryId", "clientId", "projectId"]) {
    if (entry[field] === null || entry[field] === undefined || entry[field] === "") {
      throw new RangeError(field + " is required");
    }
  }
  if (entry.taskId === undefined) throw new RangeError("taskId must be explicit (null allowed)");
  if (typeof entry.billable !== "boolean") throw new RangeError("billable must be true or false");
  const originalStart = instant(entry.startUtc, "startUtc");
  const originalEnd = instant(entry.endUtc, "endUtc");
  seconds(originalStart, originalEnd);

  if (entry.hasUnresolvedSleep && !Array.isArray(entry.eligibleIntervals)) {
    throw new RangeError("Sleep resolution requires explicit eligibleIntervals");
  }
  const qualified = entry.eligibleIntervals ??
    [{ startUtc: entry.startUtc, endUtc: entry.endUtc }];
  if (!Array.isArray(qualified)) throw new TypeError("eligibleIntervals must be an array");

  let previousEnd = originalStart;
  let confirmedSeconds = 0;
  const result = [];
  for (const interval of qualified) {
    const from = instant(interval.startUtc, "eligible startUtc");
    const to = instant(interval.endUtc, "eligible endUtc");
    const elapsed = seconds(from, to);
    if (from.epochNanoseconds < originalStart.epochNanoseconds ||
        to.epochNanoseconds > originalEnd.epochNanoseconds ||
        from.epochNanoseconds < previousEnd.epochNanoseconds) {
      throw new RangeError("eligibleIntervals must be ordered, disjoint and within source interval");
    }
    previousEnd = to;
    confirmedSeconds += elapsed;
    let cursor = from;
    while (cursor.epochNanoseconds < to.epochNanoseconds) {
      const view = cursor.toZonedDateTimeISO(zone);
      const nextMidnight = view.startOfDay().add({ days: 1 }).toInstant();
      const boundary = nextMidnight.epochNanoseconds < to.epochNanoseconds ? nextMidnight : to;
      result.push({
        entryId: entry.entryId, clientId: entry.clientId, projectId: entry.projectId,
        taskId: entry.taskId, billable: entry.billable, state: "completed",
        originalStartUtc: originalStart.toString(), originalEndUtc: originalEnd.toString(),
        segmentStartUtc: cursor.toString(), segmentEndUtc: boundary.toString(),
        localDate: view.toPlainDate().toString(), segmentSeconds: seconds(cursor, boundary),
      });
      cursor = boundary;
    }
  }
  if (!Number.isSafeInteger(confirmedSeconds)) throw new RangeError("Total exceeds safe integer");
  if (entry.durationSeconds !== undefined && entry.durationSeconds !== confirmedSeconds) {
    throw new RangeError("Confirmed interval seconds disagree with stored durationSeconds");
  }
  return result;
}

// Pure reference for the Calendar agreement; actual client filtering must be enforced in SQLite.
export function summarizeCalendar(entries, { reportTimezone, fromLocalDate, toLocalDate, clientId = null }) {
  const zone = timezone(reportTimezone);
  const from = localDate(fromLocalDate);
  const to = localDate(toLocalDate);
  if (from > to) throw new RangeError("Inverted local date range");
  const segments = [];
  for (const entry of entries) {
    if (clientId !== null && entry.clientId !== clientId) continue;
    for (const piece of segmentCompletedEntry(entry, zone)) {
      if (piece.localDate >= from && piece.localDate <= to) segments.push(piece);
    }
  }
  const byLocalDateSeconds = {};
  for (const part of segments) {
    byLocalDateSeconds[part.localDate] =
      (byLocalDateSeconds[part.localDate] ?? 0) + part.segmentSeconds;
  }
  return { segments, byLocalDateSeconds,
    totalSeconds: segments.reduce((total, part) => total + part.segmentSeconds, 0) };
}
