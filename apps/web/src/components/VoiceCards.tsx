"use client";

import { useState } from "react";

export interface Voice {
  name: string;
  handle: string;
  field: string;
  selected?: boolean;
}

const SCIENCE_VOICES: Voice[] = [
  { name: "Elisabeth Bik", handle: "elisabethbik.bsky.social", field: "Research integrity" },
  { name: "Carl T. Bergstrom", handle: "carlbergstrom.com", field: "Information science & biology" },
  { name: "Katharine Hayhoe", handle: "katharinehayhoe.com", field: "Climate science" },
  { name: "Jonathan Eisen", handle: "phylogenomics.bsky.social", field: "Evolutionary ecology" },
  { name: "Kate Starbird", handle: "katestarbird.bsky.social", field: "Disinformation research" },
  { name: "Chanda Prescod-Weinstein", handle: "chanda.bsky.social", field: "Theoretical physics" },
  { name: "Mark Peifer", handle: "peiferlabunc.bsky.social", field: "Cell biology" },
  { name: "Rebecca Sear", handle: "rebeccasear.bsky.social", field: "Evolutionary anthropology" },
  { name: "Heather Cox Richardson", handle: "hcrichardson.bsky.social", field: "American history" },
  { name: "Don Moynihan", handle: "donmoyn.bsky.social", field: "Public policy" },
  { name: "J. Chris Pires", handle: "jchrispires.bsky.social", field: "Plant science" },
  { name: "Andrew Heiss", handle: "andrew.heiss.phd", field: "NGOs & human rights" },
];

const CATEGORY_MAP: Record<string, Voice[]> = {
  "Science & Research": SCIENCE_VOICES.filter(v =>
    ["Research integrity", "Information science & biology", "Evolutionary ecology", "Cell biology", "Evolutionary anthropology", "Plant science"].includes(v.field)
  ),
  "Climate & Policy": SCIENCE_VOICES.filter(v =>
    ["Climate science", "Public policy", "NGOs & human rights"].includes(v.field)
  ),
  "Physics & Math": SCIENCE_VOICES.filter(v =>
    ["Theoretical physics"].includes(v.field)
  ),
  "Society & History": SCIENCE_VOICES.filter(v =>
    ["Disinformation research", "American history"].includes(v.field)
  ),
};

function initials(name: string): string {
  return name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
}

const COLORS = [
  "linear-gradient(135deg, var(--aurora-deep), var(--jade))",
  "linear-gradient(135deg, var(--amber), var(--ember))",
  "linear-gradient(135deg, var(--aurora), var(--moss))",
  "linear-gradient(135deg, var(--rose), var(--amber))",
  "linear-gradient(135deg, var(--jade), var(--aurora-deep))",
  "linear-gradient(135deg, var(--ember), var(--gold))",
];

interface VoiceCardsProps {
  onAddVoices: (voices: Voice[]) => void;
  onDismiss: () => void;
}

export default function VoiceCards({ onAddVoices, onDismiss }: VoiceCardsProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(handle: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });
  }

  function handleAdd() {
    const voices = SCIENCE_VOICES.filter(v => selected.has(v.handle));
    onAddVoices(voices);
  }

  return (
    <div className="vc-container">
      <div className="vc-header">
        <div>
          <div className="vc-label">Suggested voices</div>
          <div className="vc-subtitle">Popular voices in this space. Tap to add them to your feed.</div>
        </div>
        <button className="vc-dismiss" onClick={onDismiss}>×</button>
      </div>

      <div className="vc-scroll">
        {Object.entries(CATEGORY_MAP).map(([category, voices]) => (
          <div key={category} className="vc-category">
            <div className="vc-cat-label">{category}</div>
            <div className="vc-grid">
              {voices.map((voice, i) => (
                <button
                  key={voice.handle}
                  className={`vc-card ${selected.has(voice.handle) ? "selected" : ""}`}
                  onClick={() => toggle(voice.handle)}
                >
                  <div className="vc-avatar" style={{ background: COLORS[i % COLORS.length] }}>
                    {initials(voice.name)}
                  </div>
                  <div className="vc-info">
                    <div className="vc-name">{voice.name}</div>
                    <div className="vc-handle">@{voice.handle}</div>
                    <div className="vc-field">{voice.field}</div>
                  </div>
                  <div className="vc-check">
                    {selected.has(voice.handle) ? "✓" : "+"}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {selected.size > 0 && (
        <div className="vc-footer">
          <span className="vc-count">{selected.size} voice{selected.size !== 1 ? "s" : ""} selected</span>
          <button className="vc-add-btn" onClick={handleAdd}>
            Add to feed
          </button>
        </div>
      )}
    </div>
  );
}
