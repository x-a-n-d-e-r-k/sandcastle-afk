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

export interface PrPipeline {
  id: string;
  status: string;
}

export const issueList = (...rest: Arg[]): IssueListItem[] =>
  forgeJSON<IssueListItem[]>(`issue-list ${rest.join(" ")}`.trim());

export const issueView = (num: number, ...rest: Arg[]): IssueView =>
  forgeJSON<IssueView>(`issue-view ${[num, ...rest].join(" ")}`.trim());

export const issueCreate = (...rest: Arg[]): string =>
  forge(`issue-create ${rest.join(" ")}`.trim());

export const issueEdit = (num: number, ...rest: Arg[]): void => {
  forge(`issue-edit ${[num, ...rest].join(" ")}`.trim());
};

export const issueClose = (num: number, ...rest: Arg[]): void => {
  forge(`issue-close ${[num, ...rest].join(" ")}`.trim());
};

export const issueComment = (num: number, ...rest: Arg[]): void => {
  forge(`issue-comment ${[num, ...rest].join(" ")}`.trim());
};

export const issueComments = (num: number, ...rest: Arg[]): string =>
  forge(`issue-comments ${[num, ...rest].join(" ")}`.trim());

export const prCreate = (...rest: Arg[]): void => {
  forge(`pr-create ${rest.join(" ")}`.trim());
};

export const prList = (...rest: Arg[]): PrListItem[] =>
  forgeJSON<PrListItem[]>(`pr-list ${rest.join(" ")}`.trim());

export const prView = (num: number, ...rest: Arg[]): PrView =>
  forgeJSON<PrView>(`pr-view ${[num, ...rest].join(" ")}`.trim());

export const prDiff = (num: number, ...rest: Arg[]): string =>
  forge(`pr-diff ${[num, ...rest].join(" ")}`.trim());

export const prApprove = (num: number, ...rest: Arg[]): void => {
  forge(`pr-approve ${[num, ...rest].join(" ")}`.trim());
};

export const prRequestChanges = (num: number, ...rest: Arg[]): void => {
  forge(`pr-request-changes ${[num, ...rest].join(" ")}`.trim());
};

export const prChangesCount = (num: number, ...rest: Arg[]): string =>
  forge(`pr-changes-count ${[num, ...rest].join(" ")}`.trim());

export const prClearChanges = (num: number, ...rest: Arg[]): void => {
  forge(`pr-clear-changes ${[num, ...rest].join(" ")}`.trim());
};

export const prMerge = (num: number, ...rest: Arg[]): void => {
  forge(`pr-merge ${[num, ...rest].join(" ")}`.trim());
};

export const prLabel = (num: number, ...rest: Arg[]): void => {
  forge(`pr-label ${[num, ...rest].join(" ")}`.trim());
};

export const prComment = (num: number, ...rest: Arg[]): void => {
  forge(`pr-comment ${[num, ...rest].join(" ")}`.trim());
};

export const prFeedback = (num: number, ...rest: Arg[]): string =>
  forge(`pr-feedback ${[num, ...rest].join(" ")}`.trim());

export const prPipeline = (num: number, ...rest: Arg[]): PrPipeline =>
  forgeJSON<PrPipeline>(`pr-pipeline ${[num, ...rest].join(" ")}`.trim());

export const prPipelineRetry = (num: number, ...rest: Arg[]): string =>
  forge(`pr-pipeline-retry ${[num, ...rest].join(" ")}`.trim());

export const prPipelineFailedJobs = (num: number, ...rest: Arg[]): string =>
  forge(`pr-pipeline-failed-jobs ${[num, ...rest].join(" ")}`.trim());

export const prPipelineFailures = (num: number, ...rest: Arg[]): string =>
  forge(`pr-pipeline-failures ${[num, ...rest].join(" ")}`.trim());

export const prPipelineRetryCount = (num: number, ...rest: Arg[]): string =>
  forge(`pr-pipeline-retry-count ${[num, ...rest].join(" ")}`.trim());

export const prPipelineRetryMark = (num: number, ...rest: Arg[]): void => {
  forge(`pr-pipeline-retry-mark ${[num, ...rest].join(" ")}`.trim());
};

export const prHasConflicts = (num: number, ...rest: Arg[]): string =>
  forge(`pr-has-conflicts ${[num, ...rest].join(" ")}`.trim());

export const prConflictRetryCount = (num: number, ...rest: Arg[]): string =>
  forge(`pr-conflict-retry-count ${[num, ...rest].join(" ")}`.trim());

export const prConflictRetryMark = (num: number, ...rest: Arg[]): void => {
  forge(`pr-conflict-retry-mark ${[num, ...rest].join(" ")}`.trim());
};

export const gitSetup = (...rest: Arg[]): void => {
  forge(`git-setup ${rest.join(" ")}`.trim());
};

