import { Icon, type IconName } from "./Icon";

const sizes = {
  sm: { box: "size-9", icon: 16 },
  md: { box: "size-10", icon: 17 },
  lg: { box: "size-12", icon: 20 },
  xl: { box: "size-16", icon: 26 },
} as const;

const tones = {
  /** Soft peach circle with an orange icon, for light grounds. */
  halo: "bg-halo text-ember",
  /** Translucent white circle, for inside orange buttons. */
  glass: "bg-white/40 text-cocoa",
  /** Faint circle for cocoa grounds. */
  dark: "bg-white/10 text-ember",
  ember: "bg-ember text-cocoa",
} as const;

/** An icon sitting in a soft circle: the house way of showing icons. */
export function Halo({
  icon,
  size = "md",
  tone = "halo",
  className = "",
}: {
  icon: IconName;
  size?: keyof typeof sizes;
  tone?: keyof typeof tones;
  className?: string;
}) {
  const s = sizes[size];
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${s.box} ${tones[tone]} ${className}`}
    >
      <Icon name={icon} size={s.icon} />
    </span>
  );
}
