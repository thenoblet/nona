/**
 * Shows an SVG string from `qrSvg()` (src/lib/qr.ts). The SVG carries its own
 * role="img" and aria-label, and scales to this box.
 */
export function QrCode({ svg, className = "" }: { svg: string; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: svg }} />;
}
