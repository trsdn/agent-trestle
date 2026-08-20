const STOP_REASONS = Object.freeze({
  COMPLETE: "complete",
  NO_OP: "no-op",
  MAX_ROUNDS: "max-rounds",
  MAX_DURATION: "max-duration",
});

export { STOP_REASONS };

export function decideStop({
  completed = false,
  previousSignature,
  currentSignature,
  noOpRounds = 0,
  maxNoOpRounds = 1,
  roundsCompleted = 0,
  maxRounds = Infinity,
  elapsedMs = 0,
  maxDurationMs = Infinity,
} = {}) {
  if (completed) return { stop: true, reason: STOP_REASONS.COMPLETE };
  if (elapsedMs >= maxDurationMs) {
    return { stop: true, reason: STOP_REASONS.MAX_DURATION };
  }
  if (roundsCompleted >= maxRounds) {
    return { stop: true, reason: STOP_REASONS.MAX_ROUNDS };
  }

  const unchanged =
    previousSignature !== undefined &&
    currentSignature !== undefined &&
    previousSignature === currentSignature;
  const nextNoOpRounds = unchanged ? noOpRounds + 1 : 0;
  if (unchanged && nextNoOpRounds >= maxNoOpRounds) {
    return {
      stop: true,
      reason: STOP_REASONS.NO_OP,
      noOpRounds: nextNoOpRounds,
    };
  }
  return { stop: false, reason: null, noOpRounds: nextNoOpRounds };
}

