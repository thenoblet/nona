"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { previewedMode, type Mode } from "@/lib/mode";
import { activeTab, tabsFor, type Tab } from "./tabs";

/** Inputs that open the phone's keyboard; buttons, boxes and sliders do not. */
const NOT_TYPED = new Set(["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image", "hidden"]);

function opensKeyboard(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !NOT_TYPED.has(target.type);
}

/**
 * Whether the guest is typing: a field that opens the keyboard has focus. The bar steps aside
 * then, so it never sits on the keyboard over the RSVP or the wishes form.
 */
function useTyping(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => setTyping(opensKeyboard(event.target));
    const onFocusOut = (event: FocusEvent) => setTyping(opensKeyboard(event.relatedTarget));
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    // A field the guest tapped before the page finished loading already has focus.
    const sync = () => setTyping(opensKeyboard(document.activeElement));
    sync();
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  return typing;
}

/**
 * The bar itself: white, a hairline on top, a soft shadow upwards, 64 px with the hairline, over the
 * home bar's strip.
 * Phones only. `data-tab-bar` makes room for it at the foot of the page (globals.css).
 */
function Frame({ hidden = false, children }: { hidden?: boolean; children?: ReactNode }) {
  return (
    <nav
      aria-label="Quick links"
      data-tab-bar
      className={`fixed inset-x-0 bottom-0 z-[25] border-t border-hairline bg-white/97 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-[0_-12px_30px_rgb(61_41_39/0.10)] transition-transform duration-200 ease-out motion-reduce:transition-none lg:hidden ${
        hidden ? "translate-y-[calc(100%+40px)]" : "translate-y-0"
      }`}
    >
      <ul className="mx-auto flex h-[63px] max-w-[560px] list-none items-stretch p-0">{children}</ul>
    </nav>
  );
}

/** Holds the bar's place while the server works out which tabs today needs, so nothing jumps. */
export function TabBarFrame() {
  return <Frame />;
}

function TabLink({ tab, current }: { tab: Tab; current: boolean }) {
  const label = "text-[10px] leading-3 font-medium tracking-[0.13em] uppercase max-[359px]:tracking-[0.05em]";
  if (tab.hero) {
    // The raised middle button. On its own page the disc turns cocoa with an ember icon.
    return (
      <Link
        href={tab.href}
        aria-current={current ? "page" : undefined}
        className="press flex h-full flex-col items-center justify-end gap-1 pb-3 text-ember-ink no-underline"
      >
        <span
          className={`flex size-[58px] shrink-0 items-center justify-center rounded-full shadow-[0_0_0_5px_#fff,0_12px_26px_rgb(232_127_57/0.45)] ${
            current ? "bg-cocoa text-ember" : "bg-ember text-cocoa"
          }`}
        >
          <Icon name={tab.icon} size={25} strokeWidth={1.7} />
        </span>
        <span className={`${label} font-semibold`}>{tab.label}</span>
      </Link>
    );
  }
  return (
    <Link
      href={tab.href}
      aria-current={current ? "page" : undefined}
      className={`relative flex h-full flex-col items-center justify-center gap-1 no-underline transition-colors ${current ? "text-cocoa" : "text-[#8a716b]"}`}
    >
      {current ? <span aria-hidden className="absolute top-0 left-1/2 h-0.5 w-[22px] -translate-x-1/2 rounded-b-sm bg-ember" /> : null}
      <Icon name={tab.icon} size={23} strokeWidth={1.6} className={current ? "text-ember" : undefined} />
      <span className={label}>{tab.label}</span>
    </Link>
  );
}

/**
 * The phone's tab bar: the places guests need most, one tap away like an app, with the main action
 * raised in the middle. The tabs follow the wedding (src/components/nav/tabs.ts). `mode` is the
 * server's, from the clock; where previews are allowed, `?mode=` shows another version's tabs, as
 * it does the page's.
 */
export function TabBar({ mode, previewAllowed }: { mode: Mode; previewAllowed: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const typing = useTyping();
  const shown = (previewAllowed ? previewedMode(searchParams.get("mode")) : null) ?? mode;
  const tabs = tabsFor(shown);
  const current = activeTab(tabs, pathname);
  return (
    <Frame hidden={typing}>
      {tabs.map((tab) => (
        <li key={tab.id} className="flex min-w-0 flex-1 flex-col">
          <TabLink tab={tab} current={tab.id === current} />
        </li>
      ))}
    </Frame>
  );
}
