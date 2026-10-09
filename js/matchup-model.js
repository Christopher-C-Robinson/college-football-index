import { ACTIVE_MATCHUP_MODEL, MODEL_VERSION } from './config.js';
import { unitMatchupFeatures, UNIT_DEFINITION_VERSION } from './unit-model.js?v=111ceae2905b';

// Coefficients are frozen from the evaluated 2022–2024 fit. No runtime fitting,
// conference bonuses, or ranking-slider weights enter this correction.
export function matchupAdjustmentFor(unitProfiles, homeTeam, awayTeam) {
  const model = ACTIVE_MATCHUP_MODEL;
  const fallback = reason => ({ eligible: false, points: 0, modelId: model.id,
    featureDefinitionVersion: model.featureDefinitionVersion, reason });
  if (!model.enabled) return fallback('Matchup adjustments are disabled.');
  if (MODEL_VERSION !== model.baselineModelVersion) return fallback('The fitted matchup model is incompatible with this rating version.');
  if (unitProfiles?.definitionVersion !== model.featureDefinitionVersion
    || UNIT_DEFINITION_VERSION !== model.featureDefinitionVersion) return fallback('Compatible passing and rushing evidence is unavailable.');
  const features = unitMatchupFeatures(unitProfiles, homeTeam, awayTeam);
  if (!features.eligible) return fallback('One or both teams lack passing, rushing, or attempt-mix evidence.');
  if (JSON.stringify(features.names) !== JSON.stringify(model.featureNames)) return fallback('Matchup feature definitions do not match the fitted model.');
  const points = features.values.reduce((sum, value, index) => sum + value * model.coefficientsRaw[index], 0);
  if (!Number.isFinite(points)) return fallback('A finite matchup adjustment could not be calculated.');
  return { eligible: true, points, modelId: model.id,
    featureDefinitionVersion: model.featureDefinitionVersion, reason: null };
}
