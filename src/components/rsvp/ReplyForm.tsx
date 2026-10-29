"use client";

import { startTransition, useEffect, useRef, type FormEvent } from "react";
import { celebrations, type EventId } from "@/content/wedding";
import type { Answer } from "@/lib/data/types";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { PillButton } from "@/components/ui/Button";
import { CelebrationChoice } from "./CelebrationChoice";
import { partySizes, type RsvpState, type RsvpValues } from "./options";

const column = "mx-auto w-full max-w-xl px-5 sm:px-8";
const sectionTitle = "m-0 font-serif text-[26px] italic";

function ErrorText({ id, children }: { id: string; children?: string }) {
  if (!children) return null;
  return (
    <p id={id} className="m-0 px-1 text-[13px] leading-snug text-ember-ink">
      {children}
    </p>
  );
}

/** The reply form. Fields keep what was typed; the celebration answers live in the parent. */
export function ReplyForm({
  state,
  pending,
  dispatch,
  answers,
  onAnswer,
}: {
  state: RsvpState;
  pending: boolean;
  dispatch: (form: FormData) => void;
  answers: RsvpValues["answers"];
  onAnswer: (id: EventId, value: Answer) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const { values, errors } = state;

  // After a reply comes back with something to fix, take the guest straight to it.
  useEffect(() => {
    if (state.status !== "error") return;
    const first = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-error-focus]');
    first?.focus();
  }, [state]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    // Submit without React's automatic form reset, so nothing typed is lost.
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => dispatch(data));
  }

  return (
    <form ref={formRef} action={dispatch} onSubmit={onSubmit} noValidate className="flex flex-col">
      <div className={`${column} flex flex-col gap-5 py-8`}>
        <h2 className={sectionTitle}>About you</h2>
        <Field id="fullName" label="Your full name">
          <TextInput
            id="fullName"
            name="fullName"
            type="text"
            autoComplete="name"
            placeholder="First and last name"
            defaultValue={values.fullName}
            required
            aria-invalid={errors.fullName ? true : undefined}
            aria-describedby={errors.fullName ? "fullName-error" : undefined}
            className="aria-invalid:border-ember-ink"
          />
          <ErrorText id="fullName-error">{errors.fullName}</ErrorText>
        </Field>
        <Field id="phone" label="Phone or WhatsApp">
          <TextInput
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="So we can send you updates"
            defaultValue={values.phone}
            required
            aria-invalid={errors.phone ? true : undefined}
            aria-describedby={errors.phone ? "phone-error" : undefined}
            className="aria-invalid:border-ember-ink"
          />
          <ErrorText id="phone-error">{errors.phone}</ErrorText>
        </Field>
        <Field id="partySize" label="How many in your party?">
          <Select id="partySize" name="partySize" defaultValue={values.partySize}>
            {partySizes.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="bg-tray">
        <fieldset
          aria-describedby={errors.answers ? "answers-error" : undefined}
          className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-4.5 border-0 px-4 pt-8 pb-9 sm:px-8"
        >
          <legend className="float-left mb-1 w-full px-1 font-serif text-[26px] italic">Your celebrations</legend>
          {errors.answers ? (
            <p
              id="answers-error"
              tabIndex={-1}
              data-error-focus
              className="m-0 rounded-full bg-white/70 px-4 py-2.5 text-[13px] text-ember-ink outline-none"
            >
              {errors.answers}
            </p>
          ) : null}
          {celebrations.map((c) => (
            <CelebrationChoice
              key={c.id}
              celebration={c}
              value={answers[c.id]}
              onChange={(v) => onAnswer(c.id, v)}
            />
          ))}
        </fieldset>
      </div>

      <div className={`${column} flex flex-col gap-5.5 pt-8 pb-28`}>
        <h2 className={sectionTitle}>The details</h2>
        <Field id="otherNames" label="Names of others in your party">
          <TextInput
            id="otherNames"
            name="otherNames"
            type="text"
            placeholder="As they should appear on the seating card"
            defaultValue={values.otherNames}
          />
        </Field>
        <Field id="song" label="A song that will get you dancing">
          <TextInput id="song" name="song" type="text" placeholder="Song and artist" defaultValue={values.song} />
        </Field>

        <div className="mt-2 flex flex-col">
          <div aria-live="polite">
            {state.status === "error" ? (
              <p className="mb-3 text-center text-[13px] leading-snug text-ember-ink">
                {errors.form ?? "Almost there. Please check the highlighted details above."}
              </p>
            ) : null}
          </div>
          <PillButton type="submit" variant="emberLight" size="lg" block disabled={pending}>
            {pending ? "Sending…" : "Send my reply"}
          </PillButton>
        </div>
        <p className="-mt-1.5 text-center text-[13px] leading-relaxed text-mocha">
          Need to change something later? Send a new reply with the same name.
        </p>
      </div>
    </form>
  );
}
