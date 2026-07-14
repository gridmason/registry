/**
 * Countersign + transparency-logging surface (FR-5, FR-12; SPEC §2, §3, §4a) —
 * the final publish-pipeline step. See `./stage` for the orchestration.
 */
export {
  loadCountersignIdentity,
  isCountersignConfigured,
  CountersignConfigError,
  type CountersignIdentity,
} from './identity.js';
export {
  parsePublisherEnvelope,
  countersignEnvelope,
  type PublisherEnvelope,
  type PublisherEnvelopeError,
} from './countersign.js';
export {
  createCountersignStage,
  COUNTERSIGN_ACTOR,
  type CountersignStage,
  type CountersignInput,
  type CountersignResult,
  type CountersignFailure,
} from './stage.js';
