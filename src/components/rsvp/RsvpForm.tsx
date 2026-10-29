"use client";

import { useActionState, useState } from "react";
import type { EventId } from "@/content/wedding";
import type { Answer } from "@/lib/data/types";
import { submitRsvp } from "@/app/(site)/rsvp/actions";
import { initialRsvpState, type RsvpState, type RsvpValues } from "./options";
import { ReplyForm } from "./ReplyForm";
import { ReplySent } from "./ReplySent";

/** The RSVP flow: the form, then the thank-you with a summary. */
export function RsvpForm() {
  const [state, dispatch, pending] = useActionState(submitRsvp, initialRsvpState);
  const [answers, setAnswers] = useState<RsvpValues["answers"]>({});
  // "Change my reply" hides this saved reply and brings the form back with its values.
  const [reopened, setReopened] = useState<RsvpState | null>(null);

  if (state.status === "sent" && reopened !== state) {
    return <ReplySent values={state.values} onChange={() => setReopened(state)} />;
  }

  return (
    <ReplyForm
      state={state}
      pending={pending}
      dispatch={dispatch}
      answers={answers}
      onAnswer={(id: EventId, value: Answer) => setAnswers((prev) => ({ ...prev, [id]: value }))}
    />
  );
}
