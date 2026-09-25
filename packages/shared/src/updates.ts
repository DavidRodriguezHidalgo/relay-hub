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
