/**
 * Experiment-infrastructure failures. They are never retrieval outcomes: a
 * corrupted input, a failed run or a protocol violation must not be scored as
 * a relevance miss, so every one of them stops the experiment with a code.
 */
export type ExperimentErrorCode =
  /** A required input or artifact is absent. */
  | "input_missing"
  /** An input exists but its identity differs from the frozen protocol. */
  | "input_mismatch"
  /** An input or artifact is unreadable or structurally invalid. */
  | "input_corrupt"
  /** A role sample, label file or manifest violates the registered format. */
  | "protocol_invalid"
  /** The encoder, scorer or I/O failed while running. */
  | "run_failed"
  /** A phase was entered without the evidence its predecessor must leave. */
  | "stage_violation"
  /** The independent recomputation disagrees with the production score. */
  | "score_mismatch";

export class ExperimentError extends Error {
  readonly code: ExperimentErrorCode;

  constructor(code: ExperimentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExperimentError";
    this.code = code;
  }
}
