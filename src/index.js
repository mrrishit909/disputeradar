// Public engine surface. Explicit named re-exports only (see ENGINE_PUBLIC_API).
export {
  CHART_LABEL,
  DATA_CLASSIFICATION,
  ENGINE_CONTRACT_VERSION,
  ERROR_CODE,
  EVALUATION_STATE,
  EXCLUSION_REASON,
  FICTIONAL_RULES,
  FIXTURE_ID,
  IMPORT_LIMITS,
  LIMITATIONS,
  NOT_EVALUATED_REASON,
  POLICY_DISCLAIMER,
  SCHEMA_VERSIONS,
  SYNTHETIC_LABEL,
  WARNING_CODE,
} from './constants.js';
export { compareRationals, formatCents, ratioDisplay, sha256Hex } from './primitives.js';
export {
  datasetToCsv, datasetToJson, importDatasetCsv, importDatasetJson, mergeDatasets, validateDataset,
} from './dataset.js';
export {
  addRemediationNote, compareScenarios, createSnapshot, diffSnapshots, queryContributions, validatePolicySet,
} from './engine.js';
export { generateDrSyn001 } from './fixture.js';
export { parseReportJson, serializeReportCsv, serializeReportJson } from './report.js';
