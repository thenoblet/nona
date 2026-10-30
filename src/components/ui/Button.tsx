import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import type { IconName } from "./Icon";
import { Halo } from "./Halo";

/**
 * Raised pill buttons (primary actions) and orange-underlined text links (secondary).
 * - ember: burnt orange pill on cocoa grounds
 * - emberLight: burnt orange pill on light grounds
 * - cocoa: dark pill on light grounds
 * - white: white pill
 */
const variants = {
  ember: "bg-ember text-cocoa font-medium shadow-[var(--shadow-pill-dark)]",
  emberLight: "bg-ember text-cocoa font-medium shadow-[var(--shadow-pill-ember)]",
  cocoa: "bg-cocoa text-white shadow-[var(--shadow-pill-cocoa)]",
  white: "bg-white text-cocoa shadow-[var(--shadow-pill-white)]",
} as const;

export type PillVariant = keyof typeof variants;

type PillOwnProps = {
  variant?: PillVariant;
  /** Shows an icon in a circle at the start of the pill. */
  icon?: IconName;
  size?: "md" | "lg";
  block?: boolean;
  children: ReactNode;
  className?: string;
};

function pillClasses({ variant = "ember", icon, size = "md", block, className = "" }: Omit<PillOwnProps, "children">) {
  const pad = icon
    ? size === "lg"
      ? "py-2 pl-2 pr-7 gap-3.5 min-h-16"
      : "py-2 pl-2 pr-6 gap-3 min-h-14"
    : size === "lg"
      ? "px-9 py-4.5 min-h-14"
      : "px-7 py-3.5 min-h-12";
  return [
    "press inline-flex items-center justify-center rounded-full text-xs uppercase tracking-[0.2em] no-underline",
    variants[variant],
    pad,
    block ? "w-full" : "",
    className,
  ].join(" ");
}

function IconBubble({ icon, variant, size }: { icon: IconName; variant: PillVariant; size: "md" | "lg" }) {
  const tone = variant === "cocoa" ? "dark" : variant === "white" ? "halo" : "glass";
  return <Halo icon={icon} tone={tone} size={size === "lg" ? "lg" : "md"} />;
}

export function PillLink({
  href,
  variant = "ember",
  icon,
  size = "md",
  block,
  children,
  className,
  ...rest
}: PillOwnProps & Omit<ComponentProps<typeof Link>, "className" | "children">) {
  return (
    <Link href={href} className={pillClasses({ variant, icon, size, block, className })} {...rest}>
      {icon ? <IconBubble icon={icon} variant={variant} size={size} /> : null}
      <span>{children}</span>
    </Link>
  );
}

/** A pill that is a plain `<a>`, for file downloads: `next/link` would prefetch the file. */
export function PillAnchor({
  variant = "ember",
  icon,
  size = "md",
  block,
  children,
  className,
  ...rest
}: PillOwnProps & Omit<ComponentProps<"a">, "className" | "children">) {
  return (
    <a className={pillClasses({ variant, icon, size, block, className })} {...rest}>
      {icon ? <IconBubble icon={icon} variant={variant} size={size} /> : null}
      <span>{children}</span>
    </a>
  );
}

export function PillButton({
  variant = "ember",
  icon,
  size = "md",
  block,
  children,
  className,
  type = "button",
  ...rest
}: PillOwnProps & Omit<ComponentProps<"button">, "className" | "children">) {
  return (
    <button type={type} className={pillClasses({ variant, icon, size, block, className }) + " cursor-pointer disabled:opacity-60"} {...rest}>
      {icon ? <IconBubble icon={icon} variant={variant} size={size} /> : null}
      <span>{children}</span>
    </button>
  );
}

/** Secondary action: uppercase text with a burnt-orange underline. */
export function TextLink({
  href,
  children,
  className = "",
  ...rest
}: { children: ReactNode; className?: string } & Omit<ComponentProps<typeof Link>, "className" | "children">) {
  return (
    <Link
      href={href}
      className={`ember-link inline-flex min-h-11 items-center py-3 text-xs uppercase tracking-[0.18em] no-underline ${className}`}
      {...rest}
    >
      {children}
    </Link>
  );
}
