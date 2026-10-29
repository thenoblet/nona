import type { EventId } from "@/content/wedding";
import type { Answer } from "@/lib/data/types";

/** Shared by the form and the server action, so both agree on the allowed values. */
export const partySizes = ["Just me", "2 people", "3 people", "4 or more"] as const;

export const meals = ["[Menu option one]", "[Menu option two]", "[Vegetarian option]"] as const;

export type RsvpValues = {
  fullName: string;
  phone: string;
  partySize: string;
  answers: Partial<Record<EventId, Answer>>;
  otherNames: string;
  meal: string;
  dietary: string;
  flight: string;
  song: string;
};

export type RsvpErrors = Partial<Record<"fullName" | "phone" | "answers" | "form", string>>;

export type RsvpState = {
  status: "idle" | "error" | "sent";
  values: RsvpValues;
  errors: RsvpErrors;
};

export const emptyValues: RsvpValues = {
  fullName: "",
  phone: "",
  partySize: partySizes[0],
  answers: {},
  otherNames: "",
  meal: meals[0],
  dietary: "",
  flight: "",
  song: "",
};

export const initialRsvpState: RsvpState = { status: "idle", values: emptyValues, errors: {} };

/** Form field name for a celebration's answer. */
export const answerField = (id: EventId) => `answer-${id}`;
