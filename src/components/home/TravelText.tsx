/** One line of a travel card: "From Kumasi: about 2 hours by road" is a label and its text. */
export type TravelLine = { label: string | null; text: string };

/** A short label at the start of a line, before a colon: a few words, starting with a letter. */
const LABELLED = /^(\p{L}[^:]{1,28}):\s+(.+)$/u;

/**
 * The card's text, line by line, as the couple typed it in the admin. A line that starts with a
 * short label ("From Accra:") keeps the label apart, to show as a heading over the rest.
 */
export function travelLines(text: string): TravelLine[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const match = LABELLED.exec(line);
      if (!match || match[1].split(/\s+/).length > 4) return { label: null, text: line };
      // The text now starts a line of its own under the heading, so it starts with a capital.
      const rest = match[2].trim();
      return { label: match[1].trim(), text: rest.charAt(0).toUpperCase() + rest.slice(1) };
    });
}

/**
 * A travel card's text. Lines with a label (From Kumasi, From Accra) each get a small ember
 * heading, so a guest finds their route at a glance; text with no labels reads as it always did.
 */
export function TravelText({ text }: { text: string }) {
  const lines = travelLines(text);
  if (!lines.some((line) => line.label)) {
    return <p className="m-0 font-serif text-xl leading-relaxed whitespace-pre-line text-mocha">{text}</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {lines.map((line, index) =>
        line.label ? (
          <div key={index} className="flex flex-col gap-1">
            <h4 className="m-0 text-[11px] font-medium uppercase tracking-[0.26em] text-ember-ink">{line.label}</h4>
            <p className="m-0 font-serif text-lg leading-relaxed text-mocha">{line.text}</p>
          </div>
        ) : (
          <p key={index} className="m-0 font-serif text-lg leading-relaxed text-mocha">
            {line.text}
          </p>
        ),
      )}
    </div>
  );
}
