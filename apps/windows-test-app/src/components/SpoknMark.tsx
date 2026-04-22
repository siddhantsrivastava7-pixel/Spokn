import { useId } from "react";

interface Props {
  /** Render size in px (square). Defaults to 28, matching the sidebar slot. */
  size?: number;
  /** Optional className — applied to the <svg> for sizing via CSS if needed. */
  className?: string;
}

/**
 * Spokn brand mark — a single stem (audio in) forking into three lines
 * (transcript out). Strokes are painted with a gradient derived from the
 * current theme's --accent, so switching accent recolors the logo.
 *
 * The gradient id is randomised per-instance (useId) so multiple marks on
 * the same page do not share/clobber each other's <defs>.
 */
export function SpoknMark({ size = 28, className }: Props) {
  const gradId = `spokn-grad-${useId().replace(/[:]/g, "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradId} x1="2" y1="6" x2="30" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0%" style={{ stopColor: "var(--accent-grad-start, var(--accent))" }} />
          <stop offset="100%" style={{ stopColor: "var(--accent-grad-end, var(--accent))" }} />
        </linearGradient>
      </defs>
      <g
        stroke={`url(#${gradId})`}
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        {/* Single stem (audio in) + upper fork branch */}
        <path d="M4 16 L10.5 16 C 13.5 16 14.6 14.2 15.5 10.8 L 16.6 7.5" />
        {/* Lower fork branch */}
        <path d="M10.5 16 C 13.5 16 14.6 17.8 15.5 21.2 L 16.6 24.5" />
        {/* Three transcript lines (text out) */}
        <path d="M20 9.5 L28 9.5" />
        <path d="M20 16 L28 16" />
        <path d="M20 22.5 L28 22.5" />
      </g>
    </svg>
  );
}
