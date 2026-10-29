import type { SVGProps } from "react";

const paths = {
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  dress: <path d="M8 3l4 3 4-3 4 4-3 3v11H7V10L4 7z" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  upload: <path d="M12 16V5M7 10l5-5 5 5M5 20h14" />,
  phone: (
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  bed: (
    <>
      <path d="M3 19V6M3 14h18v5" />
      <circle cx="7" cy="10.5" r="1.8" />
      <path d="M10 14v-3h7a3 3 0 0 1 3 3" />
    </>
  ),
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  video: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="1.5" />
      <path d="M16 10l5-3v10l-5-3" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  seat: (
    <>
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="3.5" r="1.5" />
      <circle cx="12" cy="20.5" r="1.5" />
      <circle cx="3.5" cy="12" r="1.5" />
      <circle cx="20.5" cy="12" r="1.5" />
    </>
  ),
  playlist: (
    <>
      <path d="M4 6h11M4 12h11M4 18h7" />
      <path d="M18 17V8l3-1" />
      <circle cx="16.5" cy="17.5" r="1.8" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </>
  ),
  slideshow: (
    <>
      <rect x="3" y="5" width="18" height="13" rx="1.5" />
      <path d="M10 9l5 2.5-5 2.5z" />
    </>
  ),
  back: <path d="M15 6l-6 6 6 6" />,
  chevron: <path d="M6 9l6 6 6-6" />,
  menu: <path d="M4 7h16M4 12h16M4 17h10" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 17l5-5 4 4 3-3 4 4" />
    </>
  ),
} as const;

export type IconName = keyof typeof paths;

type Props = Omit<SVGProps<SVGSVGElement>, "children"> & {
  name: IconName;
  size?: number;
  strokeWidth?: number;
};

/** Inline stroke icons. Decorative by default; pass aria-label to make one meaningful. */
export function Icon({ name, size = 18, strokeWidth = 1.8, ...rest }: Props) {
  const labelled = "aria-label" in rest;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? "img" : undefined}
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}

/** Solid media glyphs for players. */
export function PlayGlyph({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={className}>
      <path d="M8 4.5l12 7.5-12 7.5z" fill="currentColor" />
    </svg>
  );
}

export function PauseGlyph({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={className}>
      <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />
    </svg>
  );
}
