"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  resetSlideshowDelayAction,
  saveSlideshowDelayAction,
  setConvertBacklogAction,
  setUploadsOpenAction,
  type DelayResult,
  type SwitchResult,
} from "@/app/admin/photos/actions";
import { shortTimeWords } from "@/lib/media/admin-item";

const NOT_SAVED = "That didn't save. Check the connection, reload the page and try again.";
const DELAY_MAX_SECONDS = 900;

type Notice = { text: string; tone: "ok" | "bad" };

type Side = "on" | "off";

/** One switch's words in each state (gate B), and what flipping it does. */
type SwitchModel = {
  title: string;
  badge: Record<Side, { tone: "ok" | "none"; text: string }>;
  text: Record<Side, string>;
  hint?: string;
  /** Asked before turning it on or off: [question, what it means, the yes button]. */
  confirm: Record<Side, [string, string, string]>;
  done: Record<Side, string>;
  /** When it already stood there: the other admin, or another tab, flipped it since this page loaded. */
  already: Record<Side, string>;
  flip: (on: boolean) => Promise<SwitchResult>;
};

/** "12 older videos are", "1 older video is". */
function waitingVideos(count: number): string {
  return count === 1 ? "1 older video is" : `${count} older videos are`;
}

function uploadsModel(closedAt: string | null): SwitchModel {
  return {
    title: "Uploads",
    badge: { on: { tone: "ok", text: "Open" }, off: { tone: "none", text: "Closed" } },
    text: {
      on: "Guests can share photos and videos.",
      off: `${closedAt ? `Closed since ${shortTimeWords(closedAt)}.` : "Closed."} Guests can still look through the album.`,
    },
    confirm: {
      off: [
        "Close uploads?",
        "Guests see “Sharing has closed” and can't send anything new. Anything already sending gets 24 hours to finish.",
        "Close uploads",
      ],
      on: ["Open uploads again?", "Guests can share straight away.", "Open uploads"],
    },
    done: { on: "Uploads are open.", off: "Uploads are closed." },
    already: { on: "Uploads were already open.", off: "Uploads were already closed." },
    flip: setUploadsOpenAction,
  };
}

function backlogModel(waiting: number): SwitchModel {
  const others = waiting === 1 ? "The other one waits" : `The other ${waiting} wait`;
  return {
    title: "Convert backlog videos",
    badge: { on: { tone: "ok", text: "On" }, off: { tone: "none", text: "Off" } },
    text: {
      on:
        waiting === 0
          ? "No older videos are waiting to be converted for phones."
          : `${waitingVideos(waiting)} waiting to be converted for phones, one at a time.`,
      off: `Paused. ${waiting === 1 ? "1 video waits" : `${waiting} videos wait`} until you turn it back on. Videos guests open, and highlights, still convert straight away.`,
    },
    hint: "Turn off over the wedding weekend so phones get their videos first.",
    confirm: {
      off: [
        "Turn off backlog conversion?",
        `Videos guests open, and highlights, still convert straight away. ${others} until you turn it back on.`,
        "Turn off",
      ],
      on: [
        "Turn on backlog conversion?",
        waiting === 1 ? "The waiting video starts converting." : `The ${waiting} waiting videos start converting, one at a time.`,
        "Turn on",
      ],
    },
    done: { on: "Backlog conversion is on.", off: "Backlog conversion is off." },
    already: { on: "Backlog conversion was already on.", off: "Backlog conversion was already off." },
    flip: setConvertBacklogAction,
  };
}

/**
 * One switch (gate B): its state, what it means for guests, and a confirm before it moves. The
 * switch doesn't move until the confirm's yes; Cancel or Escape leaves it. Its state is always the
 * server's, read again as the confirm opens and as it closes (the other admin may have flipped it
 * since this page loaded, and the question follows), and after the change; a change to where it
 * already stood says so. The yes waits while the confirm's re-read is under way, so the question
 * and its button can't change under a click.
 */
function SwitchCard({ model, on, testId }: { model: SwitchModel; on: boolean; testId: string }) {
  const questionId = useId();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [switching, startSwitching] = useTransition();
  // The re-read as the confirm opens: pending until the page has the switch's state from the server.
  const [rereading, startRereading] = useTransition();
  const router = useRouter();
  const switchButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const focusSwitch = useRef(false);
  const side: Side = on ? "on" : "off";
  const next: Side = on ? "off" : "on";
  const [question, detail, yes] = model.confirm[next];

  // The confirm opens on its safe choice; once it closes, focus goes back to the switch.
  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
    else if (focusSwitch.current) switchButton.current?.focus();
    focusSwitch.current = false;
  }, [confirming]);

  function open() {
    setConfirming(true);
    // Re-read the switch as the confirm opens: the question follows what is true now, and the yes
    // waits for it.
    startRereading(() => router.refresh());
  }

  function close() {
    focusSwitch.current = true;
    setConfirming(false);
  }

  /** Cancel, or Escape: nothing changes here, but the page reads the switch again. */
  function cancel() {
    close();
    router.refresh();
  }

  function escape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || switching) return;
    event.preventDefault();
    cancel();
  }

  function flip() {
    const target = next;
    startSwitching(async () => {
      let result: SwitchResult;
      try {
        result = await model.flip(target === "on");
      } catch {
        result = { ok: false, error: NOT_SAVED };
      }
      close();
      setNotice(
        result.ok ? { text: result.changed ? model.done[target] : model.already[target], tone: "ok" } : { text: result.error, tone: "bad" },
      );
    });
  }

  return (
    <article className="admin-switchcard" data-switch={testId} data-confirming={confirming ? "" : undefined}>
      <button
        ref={switchButton}
        type="button"
        className="admin-switch"
        role="switch"
        aria-checked={on}
        aria-label={model.title}
        onClick={() => {
          setNotice(null);
          if (confirming) cancel();
          else open();
        }}
      >
        <span className="admin-switch-label">
          <span>{model.title}</span>
          <span className={`admin-badge admin-badge-${model.badge[side].tone}`}>{model.badge[side].text}</span>
        </span>
        <span className="admin-track" aria-hidden="true" />
      </button>
      <p className="admin-switch-text">{model.text[side]}</p>
      {model.hint ? <p className="admin-switch-hint">{model.hint}</p> : null}
      {confirming ? (
        <div className="admin-confirm" role="group" aria-labelledby={questionId} onKeyDown={escape}>
          <p id={questionId}>{question}</p>
          <p>{detail}</p>
          <div className="admin-confirm-actions">
            <button
              type="button"
              className="admin-btn admin-btn-small admin-btn-primary"
              disabled={switching || rereading}
              aria-busy={rereading || undefined}
              onClick={flip}
            >
              {switching ? "Saving…" : yes}
            </button>
            <button ref={cancelButton} type="button" className="admin-btn admin-btn-small" disabled={switching} onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <p className={`admin-notice${notice?.tone === "bad" ? " admin-notice-bad" : ""}`} role="status">
        {notice?.text}
      </p>
    </article>
  );
}

/** "3 minutes", "1 minute 30 seconds", "45 seconds", "no delay". */
function delayWords(seconds: number): string {
  if (seconds === 0) return "no delay";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (rest > 0) parts.push(`${rest} ${rest === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}

/**
 * The venue TV's delay (Task 17): how long a new moment waits before the slideshow shows it, so
 * the couple can hide anything first. 0 to 900 seconds; SLIDESHOW_DELAY_SECONDS applies until they
 * save one.
 */
function TvDelayCard({ seconds, saved, defaultSeconds }: { seconds: number; saved: boolean; defaultSeconds: number }) {
  const inputId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState(String(seconds));
  // The saved delay the field last showed. When the page reads a new one (the other admin saved,
  // and a switch or a save read the page again) and nothing has been typed over the last, the field
  // follows it, so a Save without looking never puts the old delay back.
  const [shownSeconds, setShownSeconds] = useState(seconds);
  if (seconds !== shownSeconds) {
    setShownSeconds(seconds);
    if (draft.trim() === String(shownSeconds)) setDraft(String(seconds));
  }
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, startSaving] = useTransition();
  const [resetting, startResetting] = useTransition();
  const secondsField = useRef<HTMLInputElement>(null);
  const typed = draft.trim();
  const value = /^\d{1,3}$/.test(typed) ? Number(typed) : Number.NaN;
  const valid = Number.isInteger(value) && value >= 0 && value <= DELAY_MAX_SECONDS;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || resetting) return;
    if (!valid) {
      setNotice({ text: "Use a whole number of seconds from 0 to 900.", tone: "bad" });
      return;
    }
    startSaving(async () => {
      let result: DelayResult;
      try {
        result = await saveSlideshowDelayAction(value);
      } catch {
        result = { ok: false, error: NOT_SAVED };
      }
      setNotice(
        result.ok
          ? { text: `Saved. New moments reach the TV ${value === 0 ? "at once" : `after ${delayWords(value)}`}.`, tone: "ok" }
          : { text: result.error, tone: "bad" },
      );
    });
  }

  /** "Use the default": forgets the saved delay, so the environment's applies again. */
  function returnToDefault() {
    if (resetting || saving) return;
    startResetting(async () => {
      let result: DelayResult;
      try {
        result = await resetSlideshowDelayAction();
      } catch {
        result = { ok: false, error: NOT_SAVED };
      }
      if (result.ok) {
        setDraft(String(defaultSeconds));
        // Use the default goes away with the saved delay: focus stays in the card, on the seconds.
        secondsField.current?.focus();
      }
      setNotice(
        result.ok
          ? { text: `Back to the default. New moments reach the TV ${defaultSeconds === 0 ? "at once" : `after ${delayWords(defaultSeconds)}`}.`, tone: "ok" }
          : { text: result.error, tone: "bad" },
      );
    });
  }

  return (
    <article className="admin-switchcard" data-switch="tv-delay">
      <div className="admin-delay-head">
        <h2>TV delay</h2>
        <span className={`admin-badge admin-badge-${saved ? "ok" : "none"}`}>{saved ? delayWords(seconds) : "Default"}</span>
      </div>
      <p className="admin-switch-text">
        New photos and videos wait {seconds === 0 ? "no time at all" : delayWords(seconds)} before the venue TV shows them, so you can hide
        anything first.
      </p>
      <form className="admin-delay-form" onSubmit={save} noValidate>
        <div className={`admin-field${notice?.tone === "bad" ? " admin-field-invalid" : ""}`}>
          <label htmlFor={inputId}>Seconds</label>
          <input
            ref={secondsField}
            id={inputId}
            name="seconds"
            type="number"
            inputMode="numeric"
            min={0}
            max={DELAY_MAX_SECONDS}
            step={1}
            value={draft}
            aria-describedby={hintId}
            aria-invalid={notice?.tone === "bad" ? true : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setNotice(null);
            }}
          />
        </div>
        <button type="submit" className="admin-btn admin-btn-primary" aria-disabled={saving || resetting}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved ? (
          <button type="button" className="admin-btn" aria-disabled={saving || resetting} onClick={returnToDefault}>
            {resetting ? "Saving…" : "Use the default"}
          </button>
        ) : null}
        <span id={hintId} className="admin-field-hint">
          0 to 900 seconds (15 minutes).{" "}
          {saved ? `The default is ${delayWords(defaultSeconds)}.` : `Using the default, ${delayWords(defaultSeconds)}, until you save one.`}
        </span>
      </form>
      <p className={`admin-notice${notice?.tone === "bad" ? " admin-notice-bad" : ""}`} role="status">
        {notice?.text}
      </p>
    </article>
  );
}

/** The Photos page's switches (gate B) and the TV delay, above the Album and Wishes tabs. */
export function PhotoSwitches({
  uploads,
  backlog,
  delay,
}: {
  uploads: { open: boolean; closedAt: string | null };
  backlog: { on: boolean; waiting: number };
  delay: { seconds: number; saved: boolean; defaultSeconds: number };
}): ReactNode {
  return (
    <section className="admin-switches" aria-label="Switches">
      <SwitchCard model={uploadsModel(uploads.closedAt)} on={uploads.open} testId="uploads" />
      <SwitchCard model={backlogModel(backlog.waiting)} on={backlog.on} testId="backlog" />
      <TvDelayCard {...delay} />
    </section>
  );
}
