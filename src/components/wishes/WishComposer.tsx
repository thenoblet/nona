"use client";

import { useActionState, useState } from "react";
import { sendWish, type WishFormState } from "@/app/(site)/wishes/actions";
import type { WishKind } from "@/lib/data/types";
import { PillButton } from "@/components/ui/Button";
import { Field, TextArea, TextInput } from "@/components/ui/Field";
import { Halo } from "@/components/ui/Halo";
import { Segmented } from "@/components/ui/Segmented";
import { saveGuestName, useGuestName } from "@/components/album/guestName";
import { VideoRecorder, VoiceRecorder } from "./Recorders";

const modes: { value: WishKind; label: string }[] = [
  { value: "text", label: "Write" },
  { value: "voice", label: "Voice note" },
  { value: "video", label: "Video" },
];

const initialState: WishFormState = { status: "idle" };

/** The guestbook form: write a wish (sent with a Server Action), or record one (coming soon). */
export function WishComposer() {
  const [mode, setMode] = useState<WishKind>("text");
  const [state, formAction, pending] = useActionState(sendWish, initialState);
  // The id of the last thank-you the guest closed with "Write another".
  const [closed, setClosed] = useState<string | null>(null);
  const savedName = useGuestName();

  if (state.status === "sent" && state.sent && state.sent.id !== closed) {
    const { id, signedAs } = state.sent;
    return <ThankYou name={signedAs} onAgain={() => setClosed(id)} />;
  }

  const errors = state.status === "error" ? state.errors : undefined;
  // Recording isn't built yet, so only written wishes can be sent.
  const canSend = mode === "text";

  return (
    <div className="flex flex-col gap-4">
      <Segmented role="tablist" label="Type of wish" options={modes} value={mode} onChange={setMode} />

      <form
        action={formAction}
        onSubmit={(e) => saveGuestName(String(new FormData(e.currentTarget).get("signedAs") ?? ""))}
        className="flex flex-col gap-4"
      >
        <input type="hidden" name="kind" value={mode} />

        {/* Kept mounted while hidden so a half-written wish survives a peek at the other tabs. */}
        <div role="tabpanel" aria-label="Write" hidden={mode !== "text"}>
          <Field
            id="wish"
            label="Your message to Noblet & Nancy"
            hint={errors?.message ? <span id="wish-error" className="text-ember-ink">{errors.message}</span> : undefined}
          >
            <TextArea
              id="wish"
              name="message"
              rows={5}
              required
              maxLength={1000}
              defaultValue={state.values?.message}
              placeholder="A blessing, a memory, or some advice for married life"
              aria-invalid={errors?.message ? true : undefined}
              aria-describedby={errors?.message ? "wish-error" : undefined}
            />
          </Field>
        </div>
        {mode === "voice" ? (
          <div role="tabpanel" aria-label="Voice note">
            <VoiceRecorder />
          </div>
        ) : null}
        {mode === "video" ? (
          <div role="tabpanel" aria-label="Video">
            <VideoRecorder />
          </div>
        ) : null}

        <Field
          id="signed"
          label="Sign your wish"
          hint={errors?.signedAs ? <span id="signed-error" className="text-ember-ink">{errors.signedAs}</span> : undefined}
        >
          <TextInput
            id="signed"
            name="signedAs"
            type="text"
            autoComplete="name"
            required
            maxLength={80}
            // Keyed so the remembered name fills in once it loads on the phone.
            key={savedName ?? "no-name"}
            defaultValue={state.values?.signedAs ?? savedName ?? ""}
            placeholder="Your name"
            aria-invalid={errors?.signedAs ? true : undefined}
            aria-describedby={errors?.signedAs ? "signed-error" : undefined}
          />
        </Field>

        {errors?.form ? (
          <p role="alert" className="m-0 text-center text-sm text-ember-ink">
            {errors.form}
          </p>
        ) : null}

        <PillButton type="submit" variant="cocoa" size="lg" block disabled={pending || !canSend}>
          {pending ? "Sending…" : "Send my wish"}
        </PillButton>
      </form>
    </div>
  );
}

function ThankYou({ name, onAgain }: { name: string; onAgain: () => void }) {
  return (
    <div
      role="status"
      tabIndex={-1}
      ref={(el) => el?.focus()}
      className="flex animate-rise flex-col items-center gap-3 py-6 text-center outline-none"
    >
      <Halo icon="heart" size="xl" />
      <p className="m-0 font-script text-[46px] leading-[1.1]">Thank you</p>
      <p className="m-0 max-w-xs font-serif text-xl leading-relaxed text-mocha">
        {name}, your wish is on the wall below. Noblet and Nancy will treasure it.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-6 gap-y-1">
        <a href="#wall-h" className="ember-link inline-flex min-h-11 items-center text-xs uppercase tracking-[0.18em] no-underline">
          See the wall
        </a>
        <button
          type="button"
          onClick={onAgain}
          className="ember-link inline-flex min-h-11 cursor-pointer items-center text-xs uppercase tracking-[0.18em]"
        >
          Write another
        </button>
      </div>
    </div>
  );
}
