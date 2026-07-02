import type { MechanicalFilters } from "./types";
import {
  DEFAULT_MECHANICAL_FILTERS,
  DEFAULT_CANDIDATE_BUDGET,
  DEFAULT_ENGAGEMENT_WEIGHT,
  DEFAULT_RECENCY_WEIGHT,
  DEFAULT_RECENCY_HALFLIFE_H,
} from "./defaults";

// Starter feed config that can be imported into any user's feed via
// POST /api/feeds/template. Used today to make dev testing seamless (a fresh
// anonymous session gets a working feed in one call, so the onboarding
// surface never shows and the Tune panel is reachable); could later back an
// onboarding "start from a template" action. One plain object, iterate freely.
export const TEMPLATE_FEED_CONFIG: {
  subqueries: string[];
  mechanical_filters: MechanicalFilters;
  candidate_budget: number;
  rerank_prompt: string;
  engagement_weight: number;
  recency_weight: number;
  recency_halflife_h: number;
} = {
  subqueries: [
    "personal essays on AI and creative work",
    "indie web and small internet culture",
    "science and space discoveries explained well",
  ],
  mechanical_filters: DEFAULT_MECHANICAL_FILTERS,
  candidate_budget: DEFAULT_CANDIDATE_BUDGET,
  rerank_prompt:
    "Favor thoughtful first person writing, original reporting, and posts that teach something concrete. Drop engagement bait, outrage, and low effort link drops.",
  engagement_weight: DEFAULT_ENGAGEMENT_WEIGHT,
  recency_weight: DEFAULT_RECENCY_WEIGHT,
  recency_halflife_h: DEFAULT_RECENCY_HALFLIFE_H,
};
