/**
 * The ordered migration set. Append new migrations here; never reorder or edit
 * an already-shipped entry — add a follow-on migration instead.
 */
import { migration0001 } from './0001_initial_schema.js';
import { migration0002 } from './0002_publisher_oidc_claims.js';
import { migration0003 } from './0003_artifact_envelope.js';
import { migration0004 } from './0004_review_case_waiver.js';
import { migration0005 } from './0005_release_doc_log_entry.js';
import { migration0006 } from './0006_review_case_appeal.js';
import type { Migration } from './types.js';

export type { Migration };

export const migrations: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
];
