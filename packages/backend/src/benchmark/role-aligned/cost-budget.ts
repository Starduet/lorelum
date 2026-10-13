import { digestJson } from "./digest";

/**
 * Cost limits for the role-aligned conditions, frozen on 2026-10-08 from the
 * measured control (verification section 25) and before any role-condition
 * result exists. They bound cost, not quality: a breach blocks product wiring
 * and is reported next to the quality result, never traded against it.
 *
 * Every number is the measured control value times a stated factor, rounded.
 * They hold for the measured device class only and make no claim about larger
 * corpora; scoring work grows linearly with texts x views x dimensions, which
 * the measurements here cannot extrapolate.
 */
export const COST_BUDGET_ID = "role-aligned-cost-budget/1";

export const COST_BUDGET = Object.freeze({
  id: COST_BUDGET_ID,
  deviceClass:
    "one local CPU, 4 embedding threads, the frozen embedding model and native runtime, no GPU",
  measurementRule:
    "single sequential request, warm runtime after one discarded encode, p95 over every query of the evaluated set; cold start and cold cache are reported separately and never averaged in",
  query: Object.freeze({
    /** Control: at most 4 clause texts per query. */
    maxEncodedTextsPerQuery: 8,
    /** Control p95 41.3 ms per query x 4. */
    encodeMsP95: 165,
    /** Control: 0.8 ms (warm) to 2.1 ms (worst observed cold run) per query over 97 Practices and 1232 views; about 3.8 x the worst cold figure. */
    scoringMsMean: 8,
  }),
  analyzer: Object.freeze({
    /** Added to the query path by an automatic role analyzer; about 4.8 x the control p95. */
    addedMsP95: 200,
    callsPerQuery: 1,
    /** An analyzer is never invoked per Practice. */
    callsPerPractice: 0,
    /** About 1 x the embedding runtime's measured peak working set. */
    addedPeakResidentMegabytes: 450,
  }),
  endToEnd: Object.freeze({
    /** Analyzer plus query encoding plus scoring. */
    queryMsP95: 400,
  }),
  memory: Object.freeze({
    /** Control evaluation process peak RSS 120.8 to 128.6 MB across runs; 190 is about 1.5 x the worst. */
    evaluationProcessPeakRssMegabytes: 190,
    /** Control native runtime 449 MB peak working set, sampled every 250 ms (a lower bound), plus headroom. */
    nativeRuntimePeakMegabytes: 500,
  }),
  startup: Object.freeze({
    /** Control native runtime start 1.0 s (model file in the OS cache) to 6.5 s (worst observed); 1.25 x the worst. */
    runtimeStartMs: 8100,
  }),
  document: Object.freeze({
    /** Q and Q+I reuse the existing document vectors. */
    addedEncodedViewFractionQ: 0,
    /** Q+I+D may encode at most a quarter more views than the control's 1232. */
    addedEncodedViewFractionQID: 0.25,
  }),
});

export const COST_BUDGET_DIGEST = digestJson(COST_BUDGET);
