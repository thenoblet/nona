import type { Metadata } from "next";
import { Suspense } from "react";
import { couple } from "@/content/wedding";
import { albumUrl, displayUrl, qrSvg } from "@/lib/qr";
import { QrCode } from "@/components/slideshow/QrCode";
import { PrintButton } from "./PrintButton";

export const metadata: Metadata = {
  title: "Table card",
  robots: { index: false },
};

/*
 * The card is drawn at 600 design pixels wide. Inside it one spacing step is one
 * design pixel: 148 mm / 600 on paper, and shrunk to fit on a phone screen.
 */
const printCss = `
.table-card { --spacing: min(calc(148mm / 600), calc((100vw - 32px) / 600)); }
@page { size: A5 portrait; margin: 0; }
@media print {
  html, body { background: #fff !important; min-height: 0 !important; }
  body > :not(:has(.table-card)) { display: none !important; }
  .table-card {
    --spacing: calc(148mm / 600);
    width: 148mm;
    height: 209.9mm;
    overflow: hidden;
    box-shadow: none !important;
    break-inside: avoid;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
`;

const steps = ["Open your phone camera", "Point it at the code", "Share photos & videos"];

/** A5 QR card for the reception tables. `?table=7` prints the table number. */
export default function TableCardPage({ searchParams }: PageProps<"/print/table-card">) {
  return (
    <main className="flex min-h-dvh flex-col items-center gap-6 bg-tray px-4 py-8 text-cocoa print:block print:min-h-0 print:bg-white print:p-0">
      <style>{printCss}</style>

      <div className="flex max-w-md flex-col items-center gap-3 text-center print:hidden">
        <h1 className="m-0 font-script text-5xl leading-tight font-normal">Print this card</h1>
        <p className="m-0 text-sm leading-relaxed text-mocha">
          A5 portrait, at 100% scale, with headers and footers turned off. Add <code>?table=12</code> to the
          address to print another table number.
        </p>
        <PrintButton />
      </div>

      <Suspense fallback={<div className="table-card aspect-[148/210] w-600 bg-white shadow-[var(--shadow-paper)]" />}>
        <TableCard searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

/** Keeps the table label short and plain; anything odd falls back to the placeholder. */
function tableLabel(value: string | string[] | undefined) {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  return raw && /^[\p{L}\p{N} '-]{1,12}$/u.test(raw) ? raw : "[7]";
}

async function TableCard({ searchParams }: Pick<PageProps<"/print/table-card">, "searchParams">) {
  const { table } = await searchParams;
  const url = await albumUrl();
  const svg = await qrSvg(url, "QR code to the shared album");

  return (
    <article
      aria-label="Table card"
      className="table-card aspect-[148/210] w-600 bg-white p-28 font-sans text-cocoa shadow-[var(--shadow-paper)]"
    >
      <div className="h-full border border-ember p-10">
        <div className="flex h-full flex-col items-center justify-between border border-hairline px-40 pt-44 pb-36 text-center">
          <div className="flex flex-col items-center gap-10">
            <p className="m-0 font-script text-[calc(var(--spacing)*40)] leading-none text-ember">{couple.monogram}</p>
            <p className="m-0 text-[calc(var(--spacing)*13)] tracking-[0.34em] text-mocha uppercase">
              Table {tableLabel(table)}
            </p>
          </div>

          <div className="flex flex-col items-center gap-8">
            <h2 className="m-0 font-script text-[calc(var(--spacing)*68)] leading-[1.05] font-normal">Share the moment</h2>
            <p className="m-0 font-serif text-[calc(var(--spacing)*24)] text-mocha italic">
              Help us see the day through your eyes
            </p>
          </div>

          <div className="border border-hairline bg-white p-14">
            <QrCode svg={svg} className="size-220" />
          </div>

          <ol className="m-0 grid w-full list-none grid-cols-3 gap-12 p-0">
            {steps.map((step, i) => (
              <li key={step} className="flex flex-col items-center gap-6">
                <span className="font-serif text-[calc(var(--spacing)*30)] leading-none text-ember">{i + 1}</span>
                <span className="text-[calc(var(--spacing)*14)] leading-[1.4]">{step}</span>
              </li>
            ))}
          </ol>

          <div className="flex flex-col items-center gap-4">
            <p className="m-0 text-[calc(var(--spacing)*13)] tracking-[0.2em] text-mocha uppercase">
              No app · no sign-up · reception album
            </p>
            <p className="m-0 text-[calc(var(--spacing)*15)]">
              Or visit <span className="font-medium break-words">{displayUrl(url)}</span>
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}
