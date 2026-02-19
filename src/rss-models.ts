export type FeedJob = {
  id: string;
  title: string;
  detailUrl: string;
  pubDate: string | null;
  company: string | null;
  location: string | null;
  tags: string[];
  descriptionHtml: string;
  descriptionText: string;
};

export type DetailFetchStatus = "not_requested" | "succeeded" | "failed";

export type EnrichedFeedJob = FeedJob & {
  applyUrl: string | null;
  detailFetchStatus: DetailFetchStatus;
  enrichmentError: string | null;
};
