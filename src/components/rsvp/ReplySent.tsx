"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import { celebrations, couple } from "@/content/wedding";
import { photos } from "@/content/images";
import { PillLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import type { RsvpValues } from "./options";

const statusLabel = { yes: "Attending", no: "Not attending" } as const;

/** Replaces the form once the reply is saved. */
export function ReplySent({ values, onChange }: { values: RsvpValues; onChange: () => void }) {
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const photo = photos.daisiesWrapped;

  // The form was long; bring the thank-you into view and announce it.
  useEffect(() => {
    sectionRef.current?.scrollIntoView({ block: "start" });
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section
      ref={sectionRef}
      aria-labelledby="sent-h"
      className="mx-auto flex w-full max-w-xl flex-col items-center gap-4.5 px-7 pt-14 pb-28 text-center sm:px-8"
    >
      <div className="oval relative mb-3.5 w-50 animate-rise">
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
      <h2
        id="sent-h"
        ref={headingRef}
        tabIndex={-1}
        className="animate-rise font-script text-[60px] leading-[1.05] font-normal outline-none"
        style={{ animationDelay: "150ms" }}
      >
        Thank you
      </h2>
      <p className="animate-rise text-base leading-[1.7] font-light text-mocha" style={{ animationDelay: "300ms" }}>
        Your reply is with us. We&apos;ve sent the details to your phone.
      </p>

      <ul
        aria-label="Your replies"
        className="mt-1 flex animate-rise flex-col self-stretch rounded-[var(--radius-paper)] bg-tray px-4.5 py-1.5"
        style={{ animationDelay: "450ms" }}
      >
        {celebrations.map((c) => {
          const a = values.answers[c.id];
          return (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 border-b border-hairline py-3 text-left last:border-b-0"
            >
              <span className="font-serif text-xl italic">{c.name}</span>
              <span
                className={`rounded-full px-3 py-1.5 text-[11px] whitespace-nowrap uppercase tracking-[0.16em] ${
                  a === "yes"
                    ? "bg-white text-cocoa shadow-[0_1px_2px_rgb(61_41_39/0.1)]"
                    : "border border-stone text-mocha"
                }`}
              >
                {a ? statusLabel[a] : "No answer"}
              </span>
            </li>
          );
        })}
      </ul>

      {/* TODO: link to a real .ics file (or Google Calendar) for the celebrations they accepted. */}
      <PillLink href="#" variant="cocoa" className="mt-2.5">
        <span className="inline-flex items-center gap-2.5">
          <Icon name="calendar" size={15} className="text-ember" />
          Add to my calendar
        </span>
      </PillLink>
      <button
        type="button"
        onClick={onChange}
        className="ember-link min-h-11 cursor-pointer bg-transparent text-xs uppercase tracking-[0.18em] text-cocoa"
      >
        Change my reply
      </button>
      <p className="mt-4.5 font-script text-[28px] text-ember">
        {couple.motto}, {couple.groom} &amp; {couple.bride}
      </p>
    </section>
  );
}
