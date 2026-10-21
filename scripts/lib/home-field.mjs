import { CALCULATED_HOME_FIELD_METHOD, MODEL_PARAMETERS } from '../../js/model.js';

const TEAM_FIELDS = ['homeAdjustment', 'roadAdjustment', 'homeBoostPoints', 'roadBoostPoints', 'homeFieldPoints'];

// Only a retained in-range legacy fit, a converged calculated fit, or the
// configured baseline with no venue history at all may be published. A failed
// fit with history must stop publication instead of shipping a flat 2.5 points.
export function assertPublishableHomeField(homeField, referenceSeason) {
  const gamesUsed = homeField?.gamesUsed;
  if (!Number.isInteger(gamesUsed) || gamesUsed < 0) throw new Error('Refusing to publish a home-field estimate without a valid game count.');
  if (homeField.referenceSeason !== referenceSeason || !Array.isArray(homeField.seasons) || !homeField.seasons.every(Number.isInteger)) {
    throw new Error('Refusing to publish a home-field estimate for the wrong season or with invalid season metadata.');
  }
  const teams = Array.isArray(homeField.teams) ? homeField.teams : null;
  if (gamesUsed === 0) {
    if (homeField.fitStatus === 'baseline-fallback' && homeField.leaguePoints === MODEL_PARAMETERS.homeFieldBaseline && teams?.length === 0) return homeField;
    throw new Error('Refusing to publish a home-field estimate without venue history unless it is the labeled baseline.');
  }
  const validTeams = teams?.length > 0 && teams.some(team => team?.homeGames > 0)
    && teams.every(team => String(team?.name || '').trim() && TEAM_FIELDS.every(field => Number.isFinite(team[field]))
      && Number.isInteger(team.homeGames) && team.homeGames >= 0 && Number.isInteger(team.roadGames) && team.roadGames >= 0);
  const points = homeField.leaguePoints;
  const retainedLegacy = homeField.fitStatus === 'legacy-in-range' && Number.isFinite(points)
    && points >= 0 && points <= MODEL_PARAMETERS.venueMaxPoints;
  const calculated = homeField.fitStatus === 'converged' && homeField.method === CALCULATED_HOME_FIELD_METHOD
    && Number.isFinite(points) && points > MODEL_PARAMETERS.venueMinPoints && points < MODEL_PARAMETERS.venueMaxPoints;
  if ((retainedLegacy || calculated) && validTeams) return homeField;
  throw new Error('Refusing to publish ' + gamesUsed + ' games of venue history without a valid home-field fit ('
    + (homeField.fallbackReason || homeField.fitStatus || 'unvalidated estimate') + ').');
}
