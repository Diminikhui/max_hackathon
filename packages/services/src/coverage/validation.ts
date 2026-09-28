import type { DateTime, IsoDate, Period } from "@max-hackathon/domain";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(value: string, label: string): asserts value is IsoDate {
  if (!ISO_DATE.test(value)) throw new TypeError(`${label} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} is not a calendar date`);
  }
}

export function timestamp(value: DateTime, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an ISO date-time`);
  return parsed;
}

export function endOfDay(asOf: IsoDate): number {
  assertIsoDate(asOf, "asOf");
  return Date.parse(`${asOf}T23:59:59.999Z`);
}

export function isActiveOn(validity: Period, asOf: IsoDate): boolean {
  if (validity.from === undefined && validity.to === undefined) {
    throw new TypeError("rulepack validity must have at least one boundary");
  }
  if (validity.from !== undefined) assertIsoDate(validity.from, "validity.from");
  if (validity.to !== undefined) assertIsoDate(validity.to, "validity.to");
  if (validity.from !== undefined && validity.to !== undefined && validity.from > validity.to) {
    throw new TypeError("rulepack validity.from must not be after validity.to");
  }
  return (validity.from === undefined || validity.from <= asOf) && (validity.to === undefined || asOf <= validity.to);
}
