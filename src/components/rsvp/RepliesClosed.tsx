import Image from "next/image";
import { couple } from "@/content/wedding";
import { photos } from "@/content/images";
import { PillLink } from "@/components/ui/Button";

/**
 * Shown on /rsvp instead of the form while the couple have replies closed. Its bottom padding
 * (pb-28) keeps the signature clear of the floating music pill once the page is scrolled to the end.
 */
export function RepliesClosed({ message }: { message: string }) {
  const photo = photos.daisiesWrapped;
  return (
    <section
      aria-label="Replies have closed"
      className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 px-7 pt-14 pb-28 text-center sm:px-8"
    >
      <div className="oval relative mb-3.5 w-50">
        <div
          aria-hidden
          className="oval-ring absolute -top-2.5 -right-2.5 bottom-2.5 left-2.5 rounded-t-[100px] border border-ember"
        />
        <Image
          src={photo.src}
          alt={photo.alt}
          sizes="200px"
          className="relative block aspect-[3/4] w-full rounded-t-[100px] object-cover"
          style={{ objectPosition: photo.position }}
        />
      </div>
      {/* Line breaks the couple type into the message are kept. */}
      <p className="m-0 font-serif text-[22px] leading-[1.5] whitespace-pre-line text-cocoa">{message}</p>
      <PillLink href="/home" variant="cocoa" className="mt-2">
        Back to the website
      </PillLink>
      <p className="mt-4.5 font-script text-[28px] text-ember">
        {couple.motto}, {couple.groom} &amp; {couple.bride}
      </p>
    </section>
  );
}
