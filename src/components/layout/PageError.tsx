/**
 * The words and Try again shown in place of a page that broke (an error.tsx). Lean on purpose:
 * Next loads an error page with every page it guards, so it imports nothing it doesn't draw.
 */
export function PageErrorNote({ message, retry }: { message: string; retry: () => void }) {
  return (
    <section role="alert" className="mx-auto flex max-w-xl flex-col items-center gap-5 px-4.5 pt-12 text-center sm:px-8">
      <p className="m-0 font-serif text-xl leading-relaxed text-mocha">{message}</p>
      <button
        type="button"
        onClick={() => retry()}
        className="press inline-flex min-h-12 cursor-pointer items-center justify-center rounded-full border-0 bg-cocoa px-7 py-3.5 text-xs uppercase tracking-[0.2em] text-white shadow-[var(--shadow-pill-cocoa)]"
      >
        Try again
      </button>
    </section>
  );
}
