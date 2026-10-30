"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { confirmLeave } from "./content/unsaved";

/** A link in the admin's top bar: leaving a section with unsaved edits asks first. */
export function LeaveLink(props: ComponentProps<typeof Link>) {
  return (
    <Link
      {...props}
      onClick={(event) => {
        if (!confirmLeave()) event.preventDefault();
      }}
    />
  );
}
