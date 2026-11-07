// Names that earlier releases wrote into databases, receipts and request ids. They keep working as input and are still the
// stored form of `assignments.source`, whose CHECK constraint lists them. New code uses the neutral names in objectives.mjs.
// This is the only module that spells the old names.
export const legacyFixLoopName = 'dot-fix';
// Directory of the fix ledger that `dalan backfill-objectives` reads when no path is given.
export const legacyFixLedgerPath = `.local/share/${legacyFixLoopName}/ledger.jsonl`;
// Earlier name of the `report_thread_id` key in the PR-head reviewer config. Still read; `report_thread_id` wins when both are set.
export const legacyReportThreadKey = 'lead_thread_id';
