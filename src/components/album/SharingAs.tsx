"use client";

import { useId, useLayoutEffect, useState, type FormEvent } from "react";
import { renameGuest } from "./album-client";
import { saveGuestName, syncGuestName, tieGuestName, useGuestName, type OwnGuest } from "./guestName";

/**
 * "Sharing as Ama · Change", or, for a guest who hasn't given a name, "Sharing as a guest · Add
 * your name"; either opens a small inline form to set it. Before the page knows the name (on the
 * server) it reads as a guest: never a placeholder.
 *
 * `ownGuest` is the browser's own guest as the server rendered it: after a personal link takes the
 * phone over, the phone shares as that guest's name (Ruling CG), before the line first paints. Only
 * Change renames a guest on the server.
 */
export function SharingAs({ ownGuest }: { ownGuest: OwnGuest | null }) {
  const name = useGuestName();
  const [editing, setEditing] = useState(false);
  const inputId = useId();

  const ownGuestId = ownGuest?.id;
  const ownGuestName = ownGuest?.displayName ?? null;
  useLayoutEffect(() => {
    if (ownGuestId) syncGuestName({ id: ownGuestId, displayName: ownGuestName });
  }, [ownGuestId, ownGuestName]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = String(new FormData(event.currentTarget).get("name") ?? "");
    saveGuestName(typed);
    setEditing(false);
    // The guest asked for this name: their guest takes it too, on this phone and any other.
    if (typed.trim()) {
      void renameGuest(typed).then((guestId) => {
        if (guestId) tieGuestName(guestId);
      });
    }
  }

  if (editing) {
    return (
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          Your name
        </label>
        <input
          id={inputId}
          name="name"
          defaultValue={name ?? ""}
          autoComplete="name"
          placeholder="Your name"
          maxLength={60}
          autoFocus
          className="h-11 min-w-0 flex-1 rounded-full border border-white/25 bg-white/10 px-4 text-base text-white placeholder:text-mist/80 focus:border-ember focus:outline-none"
        />
        <button
          type="submit"
          className="press min-h-11 cursor-pointer rounded-full bg-ember px-5 text-xs font-medium uppercase tracking-[0.18em] text-cocoa"
        >
          Save
        </button>
      </form>
    );
  }

  const named = Boolean(name?.trim());
  return (
    <p className="m-0 text-sm text-mist">
      Sharing as {named ? <span className="text-white">{name}</span> : "a guest"} ·{" "}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="-my-3 cursor-pointer py-3 text-ember underline underline-offset-2"
      >
        {named ? (
          <>
            Change<span className="sr-only"> your name</span>
          </>
        ) : (
          "Add your name"
        )}
      </button>
    </p>
  );
}
