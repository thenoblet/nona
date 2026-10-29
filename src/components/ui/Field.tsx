import type { ComponentProps, ReactNode } from "react";

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-[11px] uppercase tracking-[0.22em] text-mocha">
      {children}
    </label>
  );
}

/** Rounded input with a soft inner shadow. */
export function TextInput({ className = "", ...props }: ComponentProps<"input">) {
  return <input className={`field h-13 rounded-full px-5 ${className}`} {...props} />;
}

export function Select({ className = "", children, ...props }: ComponentProps<"select">) {
  return (
    <select className={`field h-13 rounded-full px-4.5 ${className}`} {...props}>
      {children}
    </select>
  );
}

export function TextArea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <textarea className={`field resize-y rounded-[20px] px-5 py-3.5 leading-relaxed ${className}`} {...props} />;
}

/** Label + control + optional hint, stacked. */
export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
      {hint ? <span className="flex items-center gap-2 text-[13px] text-mocha">{hint}</span> : null}
    </div>
  );
}
