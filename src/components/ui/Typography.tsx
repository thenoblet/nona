import type { ElementType, ReactNode } from "react";

/** Small uppercase label above headings. */
export function Eyebrow({
  children,
  tone = "mocha",
  className = "",
  as: Tag = "p",
}: {
  children: ReactNode;
  tone?: "mocha" | "ember" | "mist";
  className?: string;
  as?: ElementType;
}) {
  const color = tone === "ember" ? "text-ember" : tone === "mist" ? "text-mist" : "text-mocha";
  return (
    <Tag className={`m-0 text-[11px] uppercase tracking-[0.32em] sm:text-xs ${color} ${className}`}>{children}</Tag>
  );
}

/** The diamond ornament rule. `draw` animates it in. */
export function Ornament({ width = 180, draw = false, dot = false, className = "" }: { width?: number; draw?: boolean; dot?: boolean; className?: string }) {
  const mid = width / 2;
  const gap = 14;
  return (
    <svg
      className={`${draw ? "draw" : ""} ${className}`}
      width={width}
      height="16"
      viewBox={`0 0 ${width} 16`}
      aria-hidden
    >
      <path d={`M0 8h${mid - gap}M${mid + gap} 8h${mid - gap}`} stroke="var(--color-ember)" strokeWidth="1" />
      <path d={`M${mid} 2l6 6-6 6-6-6z`} fill="none" stroke="var(--color-ember)" strokeWidth="1" />
      {dot ? <circle cx={mid} cy="8" r="1.6" fill="var(--color-ember)" /> : null}
    </svg>
  );
}

/** Centered section heading: eyebrow, script title, optional lead line. */
export function SectionHeading({
  eyebrow,
  title,
  lead,
  id,
  tone = "light",
  ornament = false,
  className = "",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  id?: string;
  tone?: "light" | "dark";
  ornament?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center gap-3 text-center ${className}`}>
      {eyebrow ? <Eyebrow tone={tone === "dark" ? "ember" : "mocha"}>{eyebrow}</Eyebrow> : null}
      <h2
        id={id}
        className={`m-0 font-script text-[56px] leading-none font-normal sm:text-7xl lg:text-[84px] ${tone === "dark" ? "text-white" : ""}`}
      >
        {title}
      </h2>
      {ornament ? <Ornament /> : null}
      {lead ? (
        <p className={`m-0 max-w-xl font-serif text-xl leading-relaxed sm:text-[22px] ${tone === "dark" ? "text-mist" : "text-mocha"}`}>
          {lead}
        </p>
      ) : null}
    </div>
  );
}

/** Script "Always & Forever" sign-off with the orange ampersand. */
export function Motto({ className = "", amp = "text-ember" }: { className?: string; amp?: string }) {
  return (
    <span className={`font-script ${className}`}>
      Always <span className={amp}>&amp;</span> Forever
    </span>
  );
}
