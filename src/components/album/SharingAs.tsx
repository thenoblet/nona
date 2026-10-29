"use client";

import { useId, useState, type FormEvent } from "react";
import { saveGuestName, useGuestName } from "./guestName";

/** "Sharing as [Your name] · Change", with a small inline form to set the name. */
export function SharingAs() {
  const name = useGuestName();
  const [editing, setEditing] = useState(false);
  const inputId = useId();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    saveGuestName(String(new FormData(e.currentTarget).get("name") ?? ""));
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

  return (
    <p className="m-0 text-sm text-mist">
      Sharing as <span className="text-white">{name ?? "[Your name]"}</span> ·{" "}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="-my-3 cursor-pointer py-3 text-ember underline underline-offset-2"
      >
        Change<span className="sr-only"> your name</span>
      </button>
    </p>
  );
}
