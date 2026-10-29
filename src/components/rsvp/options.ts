import type { EventId } from "@/content/wedding";
import type { Answer } from "@/lib/data/types";

/** Shared by the form and the server action, so both agree on the allowed values. */
export const partySizes = ["Just me", "2 people", "3 people", "4 or more"] as const;

export type RsvpValues = {
  fullName: string;
  phone: string;
  email: string;
  partySize: string;
  answers: Partial<Record<EventId, Answer>>;
  otherNames: string;
  song: string;
};

export type RsvpErrors = Partial<Record<"fullName" | "phone" | "email" | "answers" | "form", string>>;

export type RsvpState = {
  status: "idle" | "error" | "sent";
  values: RsvpValues;
  errors: RsvpErrors;
};

export const emptyValues: RsvpValues = {
  fullName: "",
  phone: "",
  email: "",
  partySize: partySizes[0],
  answers: {},
  otherNames: "",
  song: "",
};

export const initialRsvpState: RsvpState = { status: "idle", values: emptyValues, errors: {} };

/** Form field name for a celebration's answer. */
export const answerField = (id: EventId) => `answer-${id}`;
