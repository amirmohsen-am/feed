import Link from "next/link";

export default function IntrospectBackLink({
  href = "/curator",
  label = "Back to curator",
}: {
  href?: string;
  label?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="mb-5 inline-flex min-h-10 items-center gap-2 text-sm text-[#666] transition-colors hover:text-[#1a1a1a] sm:mb-6"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
      <span>{label}</span>
    </Link>
  );
}
