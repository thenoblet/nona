import type { Metadata } from "next";
import { EnvelopeOpener } from "@/components/open/EnvelopeOpener";
import { InvitationCard } from "@/components/open/InvitationCard";
import { SongPill } from "@/components/open/SongPill";

export const metadata: Metadata = { title: "Your invitation" };

/** The sealed envelope guests open first. No dock here: the song pill sits at the foot. */
export default function OpenPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center overflow-x-clip bg-cocoa px-6 pt-16 pb-7 text-white">
      <div className="flex w-full max-w-sm flex-1 flex-col items-center justify-center">
        <EnvelopeOpener invitation={<InvitationCard />} />
      </div>
      <SongPill className="mt-10" />
    </main>
  );
}
