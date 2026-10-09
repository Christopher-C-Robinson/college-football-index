export function inferSeason(now = new Date()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('A valid date is required to infer the football season.');
  return date.getUTCFullYear() - (date.getUTCMonth() < 7 ? 1 : 0);
}

export function resolveSeason(explicit, now = new Date()) {
  const season = explicit === undefined || explicit === null || explicit === '' ? inferSeason(now) : Number(explicit);
  if (!Number.isInteger(season) || season < 2000 || season > 2100) {
    throw new Error('Pass a valid season year between 2000 and 2100.');
  }
  return season;
}
