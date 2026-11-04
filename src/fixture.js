// Deterministic literal fixture DR-SYN-001 and versioned FICTIONAL policy sets.
// No randomness or clock: every record below is written out literally from the spec.
import { CSV_IMPORT_COLUMNS, DATA_CLASSIFICATION, FICTIONAL_RULES, FIXTURE_ID, SCHEMA_VERSIONS, deepFreeze } from './constants.js';
import { datasetToCsv, datasetToJson, validateDataset } from './dataset.js';
import { validatePolicySet } from './engine.js';

function literalRecords() {
  const transactions = [];
  for (let n = 1; n <= 10; n += 1) {
    transactions.push({ id: `T${n}`, merchantId: 'M1', settledDate: '2026-10-01', amountCents: 10000, status: 'SETTLED' });
  }
  transactions.push({ id: 'T0', merchantId: 'M1', settledDate: '2026-09-30', amountCents: 5000, status: 'SETTLED' });
  // T11: PENDING, settledDate null; part of the October import batch but never in the denominator.
  transactions.push({ id: 'T11', merchantId: 'M1', settledDate: null, amountCents: 10000, status: 'PENDING' });
  return {
    schemaVersion: SCHEMA_VERSIONS.DATASET_JSON,
    dataClassification: DATA_CLASSIFICATION,
    merchants: [
      { id: 'M1', region: 'DEMO', currency: 'USD' },
      { id: 'M2', region: 'DEMO', currency: 'USD' },
    ],
    transactions,
    disputes: [
      { id: 'D1', transactionId: 'T1', reportedDate: '2026-10-03', category: 'product-not-received', status: 'OPEN' },
      { id: 'D2', transactionId: 'T2', reportedDate: '2026-10-10', category: 'cancellation', status: 'WON' },
      { id: 'D3', transactionId: 'T0', reportedDate: '2026-10-01', category: 'product-not-received', status: 'WITHDRAWN' },
      { id: 'D4', transactionId: 'T4', reportedDate: '2026-11-01', category: 'credit-not-processed', status: 'REVERSED' },
    ],
    fraudEvents: [
      { id: 'F1', transactionId: 'T1', reportedDate: '2026-10-15', status: 'REPORTED' },
      { id: 'F2', transactionId: 'T3', reportedDate: '2026-10-31', status: 'RETRACTED' },
    ],
    refunds: [
      { id: 'Q1', transactionId: 'T2', reportedDate: '2026-10-20', amountCents: 10000 },
    ],
  };
}

function policySet(policySetId, scenarioName, rule) {
  const v = validatePolicySet({ schemaVersion: SCHEMA_VERSIONS.POLICY_SET, policySetId, scenarioName, rules: [rule] });
  if (!v.ok) throw new Error('fixture policy set invalid');
  return v.policySet;
}

/**
 * Generates DR-SYN-001: the literal dataset (validated, frozen), its canonical JSON and CSV import
 * files, and the baseline/scenario fictional policy sets. Output is byte-identical on every call.
 */
export function generateDrSyn001() {
  const v = validateDataset(literalRecords());
  if (!v.ok) throw new Error('fixture dataset invalid');
  return deepFreeze({
    fixtureId: FIXTURE_ID,
    dataClassification: DATA_CLASSIFICATION,
    period: '2026-10',
    merchantId: 'M1',
    emptyMerchantId: 'M2',
    importContext: 'October 2026 import batch; T11 is PENDING with null settledDate and is excluded.',
    dataset: v.dataset,
    json: datasetToJson(v.dataset),
    csv: datasetToCsv(v.dataset),
    csvColumns: CSV_IMPORT_COLUMNS,
    policySets: {
      BASELINE_V1: policySet('DEMO-BASELINE-V1', 'Baseline: fictional DEMO-EVENT-COUNT v1 (event count)', FICTIONAL_RULES.V1_EVENT_COUNT),
      SCENARIO_V2_UNIQUE_TRANSACTION: policySet('DEMO-SCENARIO-V2', 'Scenario: fictional v2 unique transaction count', FICTIONAL_RULES.V2_UNIQUE_TRANSACTION),
      SCENARIO_V3_SETTLED_DATE_WINDOW: policySet('DEMO-SCENARIO-V3', 'Scenario: fictional v3 settled-date event window', FICTIONAL_RULES.V3_SETTLED_DATE_WINDOW),
    },
  });
}
