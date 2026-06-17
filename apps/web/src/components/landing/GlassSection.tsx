"use client";

import { useState } from "react";
import LiquidGlass from "./LiquidGlass";

/*
 * Act — Transparency. A dirty pane (Smear 007 film) over the message.
 * The first touch of the glass counts as engaging with the act (parent
 * unlocks scrolling); fully wiping it plays the reveal.
 */

export default function GlassSection({
  onInteract,
}: {
  /** fires on the FIRST wipe touch — used to open the scroll gate */
  onInteract?: () => void;
}) {
  const [cleared, setCleared] = useState(false);
  const [interacted, setInteracted] = useState(false);

  return (
    <section className={`glass-section${cleared ? " cleared" : ""}`}>
      <LiquidGlass
        preset="smear"
        onFirstWipe={() => {
          setInteracted(true);
          onInteract?.();
        }}
        onCleared={() => setCleared(true)}
      />
      <div className={`glass-hint${interacted || cleared ? "" : " visible"}`}>
        ( wipe the glass clean )
      </div>
      <div className={`glass-scroll-cue${interacted || cleared ? " visible" : ""}`}>
        <span>scroll for more</span>
        <span className="arrow">↓</span>
      </div>
    </section>
  );
}
