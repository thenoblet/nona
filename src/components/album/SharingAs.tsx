"use client";

import { useId, useState, type FormEvent } from "react";
import { saveGuestName, useGuestName } from "./guestName";

/**
 * "Sharing as Ama · Change", or, for a guest who hasn't given a name, "Sharing as a guest · Add
 * your name"; either opens a small inline form to set it. Before the page knows the name (on the
 * server) it reads as a guest: never a placeholder.
 */
export function SharingAs() {
  const name = useGuestName();
  const [editing, setEditing] = useState(false);
  const inputId = useId();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveGuestName(String(new FormData(event.currentTarget).get("name") ?? ""));
    setEditing(false);
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
