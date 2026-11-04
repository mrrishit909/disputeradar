// Test helpers: mutable copies of the literal fixture and a scoped snapshot shortcut.
import assert from 'node:assert/strict';
import { createSnapshot, generateDrSyn001, importDatasetJson } from '../src/index.js';

export const FIX = generateDrSyn001();
export const M1 = { allowedMerchantIds: ['M1'] };
export const BOTH = { allowedMerchantIds: ['M1', 'M2'] };

/** Fresh mutable plain-object copy of DR-SYN-001 (never shares references with the fixture). */
export function rawFixture() {
  return JSON.parse(FIX.json);
}

export function importObject(obj) {
  return importDatasetJson(JSON.stringify(obj));
}

export function importOk(obj) {
  const r = importObject(obj);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.dataset;
}

export function snap(dataset, { policySet = FIX.policySets.BASELINE_V1, merchantId = 'M1', period = '2026-10', session = M1 } = {}) {
  const r = createSnapshot({ dataset, policySet, merchantId, period, session });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.snapshot;
}

export function codes(result) {
  assert.equal(result.ok, false, 'expected failure');
  return result.errors.map((e) => e.code);
}

export function policy(rules, policySetId = 'TEST-SET', scenarioName = 'Test fictional set') {
  return { schemaVersion: 'disputeradar.policy-set.v1', policySetId, scenarioName, rules };
}

export function rule(overrides = {}) {
  return {
    id: 'DEMO-EVENT-COUNT', version: 1, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', region: 'DEMO',
    windowDateField: 'EVENT_REPORTED_DATE', denominatorDefinition: 'SETTLED_TRANSACTION_COUNT',
    numeratorDefinition: 'DISPUTE_AND_FRAUD_EVENT_COUNT', illustrativeThresholdBps: 2500,
    includedDisputeStatuses: ['OPEN', 'WON', 'LOST', 'WITHDRAWN', 'REVERSED'], includedFraudStatuses: ['REPORTED', 'RETRACTED'],
    ...overrides,
  };
}

/** n settled October transactions for M1 plus k disputes on the first k of them. */
export function synthetic(settled, events, { merchant = 'M1' } = {}) {
  const transactions = [];
  const disputes = [];
  for (let i = 1; i <= settled; i += 1) {
    transactions.push({ id: `X${i}`, merchantId: merchant, settledDate: '2026-10-02', amountCents: 1000, status: 'SETTLED' });
  }
  if (settled === 0) transactions.push({ id: 'XOLD', merchantId: merchant, settledDate: '2026-08-01', amountCents: 1000, status: 'SETTLED' });
  for (let i = 1; i <= events; i += 1) {
    disputes.push({ id: `E${i}`, transactionId: settled === 0 ? 'XOLD' : `X${i}`, reportedDate: '2026-10-20', category: 'cancellation', status: 'OPEN' });
  }
  return {
    schemaVersion: 'disputeradar.dataset.v1', dataClassification: 'SYNTHETIC',
    merchants: [{ id: merchant, region: 'DEMO', currency: 'USD' }], transactions, disputes, fraudEvents: [], refunds: [],
  };
}
