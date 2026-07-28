/**
 * Spinner — inline "work in flight" indicator.
 *
 * Deliberately dependency-free (an SVG + Tailwind's animate-spin) and sized in
 * px so it can sit inside a button label without shifting the text baseline.
 * Inherits `currentColor`, so callers control the hue via text-* classes.
 */

interface SpinnerProps {
  /** Square size in px. Defaults to 12 — the size that lines up with text-xs. */
  size?: number;
  className?: string;
  /** Accessible label. Omit inside a control that already announces its state. */
  label?: string;
}

export function Spinner({ size = 12, className = "", label }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={"animate-spin shrink-0 " + className}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
