"use client";

interface SendButtonProps {
  disabled?: boolean;
  onClick?: () => void;
}

// Composer send button: a solid aurora-green circle with a crisp arrow —
// the one saturated accent in the composer, matching the live badge and
// the pipeline status light.
export default function SendButton({ disabled, onClick }: SendButtonProps) {
  return (
    <button
      className="send-btn"
      type="submit"
      disabled={disabled}
      onClick={onClick}
      title="Send"
      aria-label="Send"
    >
      <svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden>
        <path
          d="M12 19V5M5 12l7-7 7 7"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
