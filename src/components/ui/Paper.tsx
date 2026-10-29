import type { CSSProperties, ElementType, ReactNode } from "react";

/**
 * A raised white card with a paper-like corner, the tactile surface.
 * Put it on a `bg-tray` section so it reads as raised.
 */
export function Paper({
  children,
  as: Tag = "div",
  className = "",
  tilt = 0,
  framed = false,
  style,
}: {
  children: ReactNode;
  as?: ElementType;
  className?: string;
  /** Slight rotation in degrees, e.g. -0.8. Flattened on hover. */
  tilt?: number;
  /** Adds the thin orange inner frame. */
  framed?: boolean;
  style?: CSSProperties;
}) {
  return (
    <Tag
      className={`rounded-[var(--radius-paper)] bg-white shadow-[var(--shadow-paper)] ${framed ? "outline outline-1 -outline-offset-[12px] outline-ember/45" : ""} ${className}`}
      style={tilt ? { transform: `rotate(${tilt}deg)`, ...style } : style}
    >
      {children}
    </Tag>
  );
}

/** A small white-framed photo print with a script caption. */
export function PrintFrame({
  children,
  caption,
  className = "",
  captionClassName = "text-[15px]",
  tilt = 0,
  style,
}: {
  children: ReactNode;
  caption?: ReactNode;
  className?: string;
  captionClassName?: string;
  tilt?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`print relative bg-white p-1.5 pb-6 shadow-[var(--shadow-print)] ${className}`}
      style={{ transform: tilt ? `rotate(${tilt}deg)` : undefined, ...style }}
    >
      {children}
      {caption ? (
        <span className={`absolute inset-x-0 bottom-1 text-center font-script text-cocoa ${captionClassName}`}>{caption}</span>
      ) : null}
    </div>
  );
}
