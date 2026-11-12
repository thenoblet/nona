import { Halo } from "@/components/ui/Halo";
import { Icon } from "@/components/ui/Icon";

/**
 * In place of the share buttons while sharing isn't open (gate A): before the couple open it, the
 * wedding's date and Add to calendar; once they close it, a thank-you. The album below stays open
 * to look through.
 */
export function UploadsClosed({ phase }: { phase: "before" | "after" }) {
  const before = phase === "before";
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-paper)] border border-white/10 bg-white/5 p-[18px]">
      <div className="flex items-start gap-3.5">
        <Halo icon={before ? "calendar" : "heart"} size="md" tone="dark" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="m-0 font-serif text-[23px] leading-[1.18] text-white italic">
            {before ? "Photo and video sharing opens on the wedding weekend" : "Sharing has closed"}
          </p>
          <p className="m-0 text-[13.5px] leading-[1.55] text-mist">
            {before
              ? "Saturday 5 December. Come back here with your camera ready."
              : "Thank you for every photo and video. The album stays here for you to look through."}
          </p>
        </div>
      </div>
      {before ? (
        <a
          href="/calendar"
          download
          className="press flex min-h-11 items-center gap-2 self-start rounded-full border border-ember/55 px-4 text-[11px] font-medium uppercase tracking-[0.14em] text-white no-underline"
        >
          <Icon name="calendar" size={15} className="text-ember" />
          Add to calendar
        </a>
      ) : null}
    </div>
  );
}
