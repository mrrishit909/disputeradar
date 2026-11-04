// Child-process probe for the timezone test (not a test file itself).
import { createSnapshot, generateDrSyn001 } from '../src/index.js';

const f = generateDrSyn001();
const r = createSnapshot({ dataset: f.dataset, policySet: f.policySets.BASELINE_V1, merchantId: 'M1', period: '2026-10', session: { allowedMerchantIds: ['M1'] } });
process.stdout.write(`${JSON.stringify({ id: r.snapshot.snapshotId, numerator: r.snapshot.evaluation.numerator, events: r.snapshot.contributions.events.map((e) => e.eventId) })}\n`);
