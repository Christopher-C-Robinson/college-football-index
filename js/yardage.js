import { YARDAGE_CONTEXT_VERSION } from './unit-model.js?v=111ceae2905b';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const key = value => String(typeof value === 'object' ? value?.name || '' : value || '').trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function estimateUnit(unitModel, unit, offenseKey, defenseKey) {
  const offense = unitModel?.profiles?.get(offenseKey)?.[unit + 'Offense'];
  const defense = unitModel?.profiles?.get(defenseKey)?.[unit + 'Defense'];
  const volume = unitModel?.attemptVolumes?.[unit];
  const offenseGames = volume?.offenseGames?.get(offenseKey);
  const defenseGames = volume?.defenseGames?.get(defenseKey);
  if (!offense || !defense || !finite(offense.adjustment) || !finite(defense.adjustment)
    || !finite(offense.adjustedRate) || !finite(defense.adjustedRate)
    || !(offense.attempts > 0) || !(defense.attempts > 0) || !(offense.games > 0) || !(defense.games > 0)
    || !finite(unitModel?.leagueMeans?.[unit]) || !finite(volume?.leagueMean)
    || !finite(volume?.offense?.get(offenseKey)) || !finite(volume?.defense?.get(defenseKey))
    || !finite(offenseGames) || !finite(defenseGames) || offenseGames <= 0 || defenseGames <= 0) return null;
  const rate = unitModel.leagueMeans[unit] + offense.adjustment - defense.adjustment;
  const attempts = Math.max(0, volume.leagueMean + volume.offense.get(offenseKey) - volume.defense.get(defenseKey));
  const yards = rate * attempts;
  return finite(yards) && finite(attempts) && finite(rate) ? { yards, attempts, rate, offenseGames, defenseGames } : null;
}

/** Experimental yardage context; this does not alter score or win forecasts. */
export function estimateYardage(unitModel, teamName, opponentName) {
  const offenseKey = key(teamName);
  const defenseKey = key(opponentName);
  const compatible = unitModel?.attemptVolumes?.definitionVersion === YARDAGE_CONTEXT_VERSION;
  const passing = compatible && offenseKey && defenseKey ? estimateUnit(unitModel, 'pass', offenseKey, defenseKey) : null;
  const rushing = compatible && offenseKey && defenseKey ? estimateUnit(unitModel, 'rush', offenseKey, defenseKey) : null;
  const missing = [!passing && 'passing', !rushing && 'rushing'].filter(Boolean);
  return {
    passing,
    rushing,
    total: passing && rushing ? passing.yards + rushing.yards : null,
    definitionVersion: YARDAGE_CONTEXT_VERSION,
    reason: missing.length ? 'Opponent-adjusted ' + missing.join(' and ') + ' yardage unavailable: both teams need usable rate and attempt-volume evidence.' : null
  };
}
