// GENERATED from .sandcastle/forge-verbs.json by gen-forge-client.ts — DO NOT EDIT BY HAND.
// Regenerate with `pnpm afk:gen-client`; forge-client.test.ts fails if this drifts from the registry.

import { forge, forgeJSON } from "./config.js";


type Arg = string | number;

export interface IssueListItem {
  number: number;
  title: string;
  labels: string[];
}

export interface IssueView {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
}

export interface PrListItem {
  number: number;
  headRef: string;
  merged: boolean;
  reviewState: string;
  labels: string[];
}

export interface PrView {
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
}

export interface PrReviewGate {
  head: string;
  blockingBody: string;
  blockingSha: string;
  rebuttal: string;
  headReviewed: string;
}

export interface PrPipeline {
  id: string;
  status: string;
}

export const issueList = (...rest: Arg[]): IssueListItem[] =>
  forgeJSON<IssueListItem[]>(["issue-list", ...rest]);

export const issueView = (num: number, ...rest: Arg[]): IssueView =>
  forgeJSON<IssueView>(["issue-view", ...[num, ...rest]]);

export const issueCreate = (...rest: Arg[]): string =>
  forge(["issue-create", ...rest]);

export const issueEdit = (num: number, ...rest: Arg[]): void => {
  forge(["issue-edit", ...[num, ...rest]]);
};

export const issueClose = (num: number, ...rest: Arg[]): void => {
  forge(["issue-close", ...[num, ...rest]]);
};

export const issueComment = (num: number, ...rest: Arg[]): void => {
  forge(["issue-comment", ...[num, ...rest]]);
};

export const issueComments = (num: number, ...rest: Arg[]): string =>
  forge(["issue-comments", ...[num, ...rest]]);

export const issueDiscussion = (num: number, ...rest: Arg[]): string =>
  forge(["issue-discussion", ...[num, ...rest]]);

export const whoami = (...rest: Arg[]): string =>
  forge(["whoami", ...rest]);

export const prCreate = (...rest: Arg[]): void => {
  forge(["pr-create", ...rest]);
};

export const prList = (...rest: Arg[]): PrListItem[] =>
  forgeJSON<PrListItem[]>(["pr-list", ...rest]);

export const prView = (num: number, ...rest: Arg[]): PrView =>
  forgeJSON<PrView>(["pr-view", ...[num, ...rest]]);

export const prDiff = (num: number, ...rest: Arg[]): string =>
  forge(["pr-diff", ...[num, ...rest]]);

export const prApprove = (num: number, ...rest: Arg[]): void => {
  forge(["pr-approve", ...[num, ...rest]]);
};

export const prRequestChanges = (num: number, ...rest: Arg[]): void => {
  forge(["pr-request-changes", ...[num, ...rest]]);
};

export const prHealCount = (num: number, ...rest: Arg[]): string =>
  forge(["pr-heal-count", ...[num, ...rest]]);

export const prHealMark = (num: number, ...rest: Arg[]): void => {
  forge(["pr-heal-mark", ...[num, ...rest]]);
};

export const prHealReset = (num: number, ...rest: Arg[]): void => {
  forge(["pr-heal-reset", ...[num, ...rest]]);
};

/** @deprecated counts changes-requested reviews, not heals; the heal budget uses prHealCount (#69) */
export const prChangesCount = (num: number, ...rest: Arg[]): string =>
  forge(["pr-changes-count", ...[num, ...rest]]);

export const prClearChanges = (num: number, ...rest: Arg[]): void => {
  forge(["pr-clear-changes", ...[num, ...rest]]);
};

export const prMerge = (num: number, ...rest: Arg[]): void => {
  forge(["pr-merge", ...[num, ...rest]]);
};

export const prLabel = (num: number, ...rest: Arg[]): void => {
  forge(["pr-label", ...[num, ...rest]]);
};

export const prComment = (num: number, ...rest: Arg[]): void => {
  forge(["pr-comment", ...[num, ...rest]]);
};

export const prReviewGate = (num: number, ...rest: Arg[]): PrReviewGate =>
  forgeJSON<PrReviewGate>(["pr-review-gate", ...[num, ...rest]]);

export const prFeedback = (num: number, ...rest: Arg[]): string =>
  forge(["pr-feedback", ...[num, ...rest]]);

export const prPipeline = (num: number, ...rest: Arg[]): PrPipeline =>
  forgeJSON<PrPipeline>(["pr-pipeline", ...[num, ...rest]]);

export const prPipelineRetry = (num: number, ...rest: Arg[]): string =>
  forge(["pr-pipeline-retry", ...[num, ...rest]]);

export const prPipelineFailedJobs = (num: number, ...rest: Arg[]): string =>
  forge(["pr-pipeline-failed-jobs", ...[num, ...rest]]);

export const prPipelineFailures = (num: number, ...rest: Arg[]): string =>
  forge(["pr-pipeline-failures", ...[num, ...rest]]);

export const prPipelineRetryCount = (num: number, ...rest: Arg[]): string =>
  forge(["pr-pipeline-retry-count", ...[num, ...rest]]);

export const prPipelineRetryMark = (num: number, ...rest: Arg[]): void => {
  forge(["pr-pipeline-retry-mark", ...[num, ...rest]]);
};

export const prHasConflicts = (num: number, ...rest: Arg[]): string =>
  forge(["pr-has-conflicts", ...[num, ...rest]]);

export const prHeadExists = (num: number, ...rest: Arg[]): string =>
  forge(["pr-head-exists", ...[num, ...rest]]);

export const prClose = (num: number, ...rest: Arg[]): void => {
  forge(["pr-close", ...[num, ...rest]]);
};

export const prConflictRetryCount = (num: number, ...rest: Arg[]): string =>
  forge(["pr-conflict-retry-count", ...[num, ...rest]]);

export const prConflictRetryMark = (num: number, ...rest: Arg[]): void => {
  forge(["pr-conflict-retry-mark", ...[num, ...rest]]);
};

export const prRecheckMergeability = (num: number, ...rest: Arg[]): void => {
  forge(["pr-recheck-mergeability", ...[num, ...rest]]);
};

export const prConflictRetryClear = (num: number, ...rest: Arg[]): void => {
  forge(["pr-conflict-retry-clear", ...[num, ...rest]]);
};

export const gitSetup = (...rest: Arg[]): void => {
  forge(["git-setup", ...rest]);
};

