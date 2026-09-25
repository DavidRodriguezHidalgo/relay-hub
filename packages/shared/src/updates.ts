/** The outcome of asking where the newest release is, compared with what is running. */
export interface UpdateCheck {
  current: string;
  /** Newest published version, or null when nothing has been published yet. */
  latest: string | null;
  newer: boolean;
  url: string | null;
  /** Release notes as written on the release. */
  notes: string | null;
  publishedAt: string | null;
  /** The downloadable build of that release, when it has one; null means there is nothing to fetch. */
  assetUrl: string | null;
  assetName: string | null;
  /** Why the check could not be completed, when it could not. */
  error: string | null;
}

/** How this copy of Relay updates: a packaged build is replaced, a working copy is pulled. */
export type UpdateMode = 'packaged' | 'checkout';

/** What pulling would do, shown before anything touches the working copy. */
export interface CheckoutPlan {
  kind: 'up-to-date' | 'ready' | 'refused';
  reason: string | null;
  branch: string | null;
  upstream: string | null;
  commits: { sha: string; subject: string }[];
  needsInstall: boolean;
}

/** What pulling did. A pull that succeeded stands even if installing afterwards did not. */
export interface CheckoutResult {
  pulled: { sha: string; subject: string }[];
  installed: boolean;
  error: string | null;
}