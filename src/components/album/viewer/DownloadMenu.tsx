"use client";

import type { Ref } from "react";
import { Icon } from "@/components/ui/Icon";
import type { DownloadChoice } from "./downloads";

/**
 * The viewer's Download button and its menu (gate B 1b), in the viewer's own dark: on phones the
 * menu spans the buttons, sitting over Save to Photos; on wide screens it hangs from Download. Up and
 * down arrows move between its choices. A HEIC's "As JPEG" says "Making the JPEG…" while the first
 * request makes it.
 */
export function DownloadMenu({
  choices,
  open,
  primary,
  makingJpeg,
  buttonRef,
  onToggle,
  onClose,
  onChoose,
}: {
  choices: DownloadChoice[];
  open: boolean;
  /** Download leads (no Save to Photos here): the ember button. */
  primary: boolean;
  makingJpeg: boolean;
  buttonRef: Ref<HTMLButtonElement>;
  onToggle: () => void;
  onClose: () => void;
  onChoose: (choice: DownloadChoice) => void;
}) {
  return (
    <div className="viewer-dl">
      <button
        ref={buttonRef}
        type="button"
        className={`viewer-download press${primary ? " is-primary" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon name="download" size={16} />
        <span>Download</span>
        <Icon name="chevron" size={14} className="viewer-chevron" />
      </button>
      <div
        role="menu"
        aria-label="Download"
        className={`viewer-menu${open ? " is-open" : ""}`}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const entries = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".viewer-choice:not(:disabled)"));
          const at = entries.indexOf(document.activeElement as HTMLElement);
          entries[(at + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length]?.focus();
        }}
      >
        <div className="viewer-menu-head">
          <p>Download</p>
          <button type="button" className="viewer-icon-button" aria-label="Close the menu" onClick={onClose} tabIndex={open ? 0 : -1}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {choices.map((choice) => {
          const busy = choice.prepare && makingJpeg;
          return (
            <button
              key={choice.variant}
              type="button"
              role="menuitem"
              className="viewer-choice"
              disabled={choice.disabled || busy}
              tabIndex={open ? 0 : -1}
              onClick={() => onChoose(choice)}
            >
              <span>
                <span className="viewer-choice-label">{choice.label}</span>
                <span className="viewer-choice-sub">{busy ? "Making the JPEG…" : choice.sub}</span>
              </span>
              {choice.disabled || busy ? <span className="viewer-spinner is-light" aria-hidden /> : <Icon name="download" size={18} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
