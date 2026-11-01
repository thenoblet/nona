"use client";

/**
 * Two or three options in a soft inset track; the chosen one lifts out as a white pill.
 * Controlled: pass `value` and `onChange`. `disabled` holds the choice where it is (the wish
 * recorder while it records): the other options dim and say so, and a tap changes nothing.
 */
export function Segmented<TValue extends string>({
  options,
  value,
  onChange,
  label,
  role = "group",
  className = "",
  activeTone = "white",
  disabled = false,
}: {
  options: { value: TValue; label: string; tone?: "white" | "mocha" }[];
  value: TValue | null;
  onChange: (value: TValue) => void;
  label: string;
  role?: "group" | "tablist";
  className?: string;
  activeTone?: "white" | "mocha";
  disabled?: boolean;
}) {
  return (
    <div
      role={role}
      aria-label={label}
      className={`grid gap-1 rounded-full bg-tray p-1 shadow-[var(--shadow-inset)] ${className}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const on = option.value === value;
        const tone = option.tone ?? activeTone;
        const held = disabled && !on;
        const active =
          tone === "mocha"
            ? "bg-mocha text-white font-medium shadow-[0_1px_2px_rgb(61_41_39/0.2)]"
            : "bg-white text-cocoa font-medium shadow-[var(--shadow-seg)]";
        return (
          <button
            key={option.value}
            type="button"
            role={role === "tablist" ? "tab" : undefined}
            aria-selected={role === "tablist" ? on : undefined}
            aria-pressed={role === "group" ? on : undefined}
            aria-disabled={held || undefined}
            onClick={() => {
              if (!held) onChange(option.value);
            }}
            className={`min-h-11 rounded-full border-0 px-1.5 py-2 text-[13px] transition-[background-color,box-shadow,color,opacity] duration-200 ${held ? "cursor-not-allowed opacity-45" : "cursor-pointer"} ${on ? active : "bg-transparent text-mocha"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
