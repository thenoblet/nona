"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Halo } from "@/components/ui/Halo";
import { Icon } from "@/components/ui/Icon";
import { MorphText } from "./UploadCards";
import { hideLinkOffer, usePersonalLink } from "./uploader/personal-link";

/*
 * The guest's personal link (gate A): offered once, under their first upload, and kept in My
 * uploads as a slim row. Share opens the phone's own share sheet (so a guest can send it to
 * themselves on WhatsApp); where the browser can't share (often inside WhatsApp itself), Copy link
 * is the only button.
 */

const SHARE_TEXT = {
  title: "My NONA'26 uploads",
  text: "My photos and videos from Noblet and Nancy's wedding",
};

const COPIED_FOR_MILLISECONDS = 2_400;

const noSubscription = () => () => {};

/** Whether this browser can open the share sheet; false on the server, so the first paint matches. */
function useCanShare(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => typeof navigator.share === "function",
    () => false,
  );
}

/** The link as shown: without its https://, cut with an ellipsis where it runs out of room. */
function shortened(link: string): string {
  return link.replace(/^https?:\/\//, "");
}

/** Copies text, through the clipboard API or, where that is refused, a selected text box. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.append(box);
    box.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      box.remove();
    }
  }
}

/** Copy link, which says Copied for a moment. */
function useCopy(link: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    await copyText(link);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MILLISECONDS);
  }
  return { copied, copy };
}

/** The card under the first completed upload, with Share, Copy link and × (Hide this). */
export function PersonalLinkOffer({ link }: { link: string }) {
  const titleId = useId();
  const canShare = useCanShare();
  const { copied, copy } = useCopy(link);
  const [leaving, setLeaving] = useState(false);

  async function share() {
    try {
      await navigator.share({ ...SHARE_TEXT, url: link });
    } catch {
      // Closing the share sheet is not an error worth showing.
    }
  }

  function hide() {
    setLeaving(true);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(hideLinkOffer, reducedMotion ? 0 : 220);
  }

  const copyLabel = (
    <>
      <span className="relative size-[15px] shrink-0">
        <Icon
          name="copy"
          size={15}
          className={`absolute inset-0 transition-[opacity,scale] duration-300 ${copied ? "scale-50 opacity-0" : ""}`}
        />
        <Icon
          name="check"
          size={15}
          strokeWidth={2.2}
          className={`absolute inset-0 text-ember-ink transition-[opacity,scale] duration-300 ${copied ? "" : "scale-50 opacity-0"}`}
        />
      </span>
      <MorphText text={copied ? "Copied" : "Copy link"} />
    </>
  );

  return (
    <section
      aria-labelledby={titleId}
      className={`relative flex animate-rise flex-col gap-3 rounded-[var(--radius-paper)] bg-white p-4 shadow-[var(--shadow-paper)] transition-[opacity,translate,scale] duration-200 ${leaving ? "-translate-y-1.5 scale-98 opacity-0" : ""}`}
    >
      <div className="flex items-center gap-3 pr-8">
        <Halo icon="link" size="md" />
        <h2 id={titleId} className="m-0 min-w-0 flex-1 font-serif text-[21px] leading-[1.2] font-normal italic">
          Your personal link
        </h2>
      </div>
      <button
        type="button"
        onClick={hide}
        aria-label="Hide this"
        className="absolute top-1.5 right-1.5 grid size-11 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-mocha"
      >
        <Icon name="close" size={18} />
      </button>
      <p className="m-0 text-sm leading-normal">Save this to find your uploads on any phone.</p>
      <p className="m-0 flex h-11 min-w-0 items-center rounded-full border border-hairline bg-blush px-4 text-sm text-cocoa shadow-[var(--shadow-inset)]">
        <span className="block min-w-0 truncate">{shortened(link)}</span>
      </p>
      <div className={`grid gap-2 ${canShare ? "grid-cols-2" : "grid-cols-1"}`}>
        {canShare ? (
          <button
            type="button"
            onClick={share}
            className="press flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-full border-0 bg-ember px-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-cocoa shadow-[var(--shadow-pill-ember)]"
          >
            <Icon name="share" size={15} />
            Share
          </button>
        ) : null}
        <button
          type="button"
          onClick={copy}
          className={`press flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-full px-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-cocoa ${
            canShare ? "border border-ember/55 bg-transparent" : "border-0 bg-ember shadow-[var(--shadow-pill-ember)]"
          }`}
        >
          {copyLabel}
        </button>
      </div>
    </section>
  );
}

/**
 * The slim row in My uploads: "Your link opens these on any phone." with Copy link. Shown once this
 * page knows the link (after an upload); Task 15's My uploads can pass the link from the server.
 */
export function PersonalLinkStrip({ link: given }: { link?: string | null }) {
  const known = usePersonalLink();
  const link = given ?? known;
  if (!link) return null;
  return <PersonalLinkStripRow link={link} />;
}

function PersonalLinkStripRow({ link }: { link: string }) {
  const { copied, copy } = useCopy(link);
  return (
    <div className="mt-1 mb-2.5 flex items-center gap-2.5 rounded-full bg-white py-2 pr-3.5 pl-2 shadow-[0_0_0_1px_var(--color-hairline)]">
      <Halo icon="link" size="sm" />
      <p className="m-0 min-w-0 flex-1 text-[13px] leading-[1.35] text-mocha">Your link opens these on any phone.</p>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 cursor-pointer border-0 border-b border-solid border-ember bg-transparent px-0 pt-2.5 pb-1 text-[11px] uppercase tracking-[0.16em] text-cocoa"
      >
        <MorphText text={copied ? "Copied" : "Copy link"} />
      </button>
    </div>
  );
}
