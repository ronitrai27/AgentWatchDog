// Local Temporal Service settings. 127.0.0.1 (not "localhost") on purpose: the
// dev server listens on IPv4 only, and "localhost" can resolve to IPv6 first
// on Windows.
export const TEMPORAL_ADDRESS =
  process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
export const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
/** Rox Lab runs: the checks of one pull request, in the sandbox. */
export const LAB_TASK_QUEUE = "rox-lab";
