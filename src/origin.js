// Data-origin attestation. Origin is decided by WHICH CODE PATH produced the in-memory dataset object,
// never by file name, bytes, content, metadata or the self-declared dataClassification field.
// Internal module: deliberately not re-exported from src/index.js.
import { DATA_ORIGIN, ORIGIN_LABELS, ORIGIN_NOTICE, CHART_LABEL, POLICY_DISCLAIMER } from './constants.js';

/** Exact frozen dataset objects created by generateDrSyn001() (identity, not equality). */
const BUNDLED_DATASETS = new WeakSet();
/** snapshotIds minted in this process from a bundled dataset (or annotated from such a snapshot). */
const ATTESTED_BUNDLED_SNAPSHOTS = new Set();

/** Called only by the built-in fixture generator. */
export function markBundledFixtureDataset(dataset) {
  BUNDLED_DATASETS.add(dataset);
  return dataset;
}

/**
 * Origin of a dataset argument by object identity. A byte-identical import, a JSON round-trip, a
 * merge result, a Proxy or any other object is UNVERIFIED_USER_SUPPLIED.
 */
export function originOfDataset(dataset) {
  return dataset !== null && typeof dataset === 'object' && BUNDLED_DATASETS.has(dataset)
    ? DATA_ORIGIN.BUNDLED_SYNTHETIC_DEMO
    : DATA_ORIGIN.UNVERIFIED_USER_SUPPLIED;
}

export function attestBundledSnapshot(snapshotId) {
  ATTESTED_BUNDLED_SNAPSHOTS.add(snapshotId);
}

export function isAttestedBundledSnapshot(snapshotId) {
  return ATTESTED_BUNDLED_SNAPSHOTS.has(snapshotId);
}

/** Exact v2 label block for an origin (also used to verify snapshots). */
export function labelsFor(origin) {
  return {
    chart: CHART_LABEL,
    dataOrigin: ORIGIN_LABELS[origin],
    originNotice: ORIGIN_NOTICE,
    policyDisclaimer: POLICY_DISCLAIMER,
  };
}
