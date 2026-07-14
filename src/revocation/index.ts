/**
 * Revocation & kill feed surface (FR-8, FR-12; SPEC §6) — the registry's
 * distribution-state authority: the store, the revoke/kill service, and the
 * signed-feed document builder.
 */
export {
  createPostgresFeedEntryStore,
  InMemoryFeedEntryStore,
  type FeedEntryStore,
  type FeedEntryRecord,
  type FeedSnapshot,
  type FeedSnapshotEntry,
  type FeedTransitionState,
  type AppendFeedEntryInput,
} from './store.js';
export {
  createRevocationService,
  type RevocationService,
  type RevocationServiceDeps,
  type IssueRevocationInput,
  type RevocationResult,
  type RevocationRejection,
  type RevocationOutcome,
} from './revocation.js';
export {
  buildRevocationFeed,
  signRevocationFeed,
  canonicalFeedBytes,
  REVOCATION_FEED_FORMAT_VERSION,
  type SignedRevocationFeed,
  type RevocationFeedSignature,
  type BuildRevocationFeedInput,
} from './feed.js';
