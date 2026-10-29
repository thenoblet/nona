import type { Metadata } from "next";
import { wedding } from "@/content/wedding";
import { PhoneHeader } from "@/components/layout/PhoneHeader";
import { Icon } from "@/components/ui/Icon";
import { Eyebrow } from "@/components/ui/Typography";
import { RsvpForm } from "@/components/rsvp/RsvpForm";

export const metadata: Metadata = { title: "RSVP" };

export default function RsvpPage() {
  return (
    <main className="flex min-h-dvh flex-col bg-white">
      <PhoneHeader>
        <div className="mt-5 flex flex-col gap-2.5">
          <Eyebrow tone="ember">Répondez s&apos;il vous plaît</Eyebrow>
          <h1 className="font-script text-[56px] leading-[1.1] font-normal sm:text-[64px]">Kindly respond</h1>
          <p className="text-[15px] leading-[1.65] font-light text-mist">
            We&apos;d love to know if you can celebrate with us. It only takes a minute.
          </p>
          <p className="mt-1.5 inline-flex items-center gap-2.5 self-start rounded-full border border-ember/50 py-1.5 pr-4 pl-1.5 text-[13px] text-linen">
            <span className="flex size-7.5 items-center justify-center rounded-full bg-white/10 text-ember">
              <Icon name="calendar" size={15} />
            </span>
            Please reply by {wedding.rsvpBy}
          </p>
        </div>
      </PhoneHeader>
      <RsvpForm />
    </main>
  );
}
