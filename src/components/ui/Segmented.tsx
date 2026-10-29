"use client";

/**
 * Two or three options in a soft inset track; the chosen one lifts out as a white pill.
 * Controlled: pass `value` and `onChange`.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  role = "group",
  className = "",
  activeTone = "white",
}: {
  options: { value: T; label: string; tone?: "white" | "mocha" }[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  role?: "group" | "tablist";
  className?: string;
  activeTone?: "white" | "mocha";
}) {
  return (
    <div
      role={role}
      aria-label={label}
      className={`grid gap-1 rounded-full bg-tray p-1 shadow-[var(--shadow-inset)] ${className}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => {
        const on = o.value === value;
        const tone = o.tone ?? activeTone;
        const active =
          tone === "mocha"
            ? "bg-mocha text-white font-medium shadow-[0_1px_2px_rgb(61_41_39/0.2)]"
            : "bg-white text-cocoa font-medium shadow-[var(--shadow-seg)]";
        return (
          <button
            key={o.value}
            type="button"
            role={role === "tablist" ? "tab" : undefined}
            aria-selected={role === "tablist" ? on : undefined}
            aria-pressed={role === "group" ? on : undefined}
            onClick={() => onChange(o.value)}
            className={`min-h-11 cursor-pointer rounded-full border-0 px-1.5 py-2 text-[13px] transition-[background-color,box-shadow,color] duration-200 ${on ? active : "bg-transparent text-mocha"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
