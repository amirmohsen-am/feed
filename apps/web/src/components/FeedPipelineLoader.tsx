"use client";

import PipelineLoader from "./PipelineLoader";
import { useCurator } from "@/app/curator/curatorContext";

/**
 * The pipeline loader as it appears inside the feed column (and the branch
 * overlay), reading live stage + metrics straight from CuratorContext. Renders
 * nothing while idle. Both the main feed and the branching journey drive the
 * same pipeline state, so this single component covers both surfaces.
 */
export default function FeedPipelineLoader() {
  const {
    pipelineStage,
    pipelineCandidates,
    pipelineHits,
    pipelineImages,
    pipelineModel,
    pipelineThinkingEnabled,
  } = useCurator();

  if (pipelineStage === "idle") return null;

  return (
    <div className="cur-feed-pl">
      <PipelineLoader
        stage={pipelineStage}
        candidates={pipelineCandidates}
        hits={pipelineHits}
        images={pipelineImages}
        model={pipelineModel}
        thinkingEnabled={pipelineThinkingEnabled}
        topK={25}
      />
    </div>
  );
}
