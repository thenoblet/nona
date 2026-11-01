"use client";

import { useActionState, useCallback, useReducer, useState, type ComponentType, type FormEvent } from "react";
import { sendWish, type WishFormState } from "@/app/(site)/wishes/actions";
import { SIGNATURE_MAX_CHARACTERS, signatureProblem } from "@/lib/data/signature";
import type { WishKind } from "@/lib/data/types";
import { PillButton } from "@/components/ui/Button";
import { Field, TextArea, TextInput } from "@/components/ui/Field";
import { Halo } from "@/components/ui/Halo";
import { Segmented } from "@/components/ui/Segmented";
import { saveGuestName, useGuestName } from "@/components/album/guestName";
import { IDLE, isBusy, transition, type RecorderEvent, type RecorderState } from "./recorder-machine";
import { loadWishSender, Recorder } from "./Recorders";
import type { RecordedKind } from "./recording";
import type { WishSenderProps } from "./WishSender";

const modes: { value: WishKind; label: string }[] = [
  { value: "text", label: "Write" },
  { value: "voice", label: "Voice note" },
  { value: "video", label: "Video" },
];

const initialState: WishFormState = { status: "idle" };


/**
 * The guestbook form (gate B 4a–4d): write a wish (sent with a Server Action), or record a voice
 * note or a video message, listen back, and send it. The recorder's state lives here, so the tabs
 * and Send wait while it records; the recorder and the upload client load on its first tap.
 */
export function WishComposer() {
  const [mode, setMode] = useState<WishKind>("text");
  const [state, formAction, pending] = useActionState(sendWish, initialState);
  // The id of the last thank-you the guest closed with "Write another".
  const [closed, setClosed] = useState<string | null>(null);
  const savedName = useGuestName();
  const recordedKind: RecordedKind = mode === "video" ? "video" : "voice";
  const [recorder, dispatch] = useReducer(
    (current: RecorderState, event: RecorderEvent) => transition(recordedKind, current, event),
    IDLE,
  );
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [signedAs, setSignedAs] = useState("");
  const [Sender, setSender] = useState<ComponentType<WishSenderProps> | null>(null);
  const busy = isBusy(recorder);

  const onSent = useCallback((sent: { id: string; signedAs: string }) => dispatch({ type: "sent", wishId: sent.id, signedAs: sent.signedAs }), []);

  if (state.status === "sent" && state.sent && state.sent.id !== closed && mode === "text") {
    const { id, signedAs: name } = state.sent;
    return <ThankYou name={name} kind="text" onAgain={() => setClosed(id)} />;
  }
  if (recorder.phase === "sent" && mode !== "text") {
    return <ThankYou name={recorder.signedAs} kind={recordedKind} onAgain={() => dispatch({ type: "another" })} />;
  }
  if (recorder.phase === "sending" && mode !== "text") {
    return Sender ? (
      <Sender kind={recordedKind} take={recorder.take} signedAs={signedAs} onSent={onSent} onRecordAgain={() => dispatch({ type: "reset" })} />
    ) : (
      <p className="m-0 py-4 text-center font-serif text-xl text-mocha italic" role="status">
        Sending your wish…
      </p>
    );
  }

  const errors = state.status === "error" ? state.errors : undefined;
  const recorded = mode !== "text";
  const nameError = recorded ? signatureError : errors?.signedAs;
  const canSend = recorded ? recorder.phase === "review" : !pending;

  function chooseMode(next: WishKind) {
    if (busy || next === mode) return;
    setMode(next);
    setSignatureError(null);
    dispatch({ type: "reset" });
  }

  function sendRecording(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (recorder.phase !== "review") return;
    const name = String(new FormData(event.currentTarget).get("signedAs") ?? "").trim();
    const problem = signatureProblem(name);
    setSignatureError(problem);
    if (problem) return;
    saveGuestName(name);
    setSignedAs(name);
    dispatch({ type: "send" });
    loadWishSender().then(
      (loaded) => setSender(() => loaded.default),
      () => dispatch({ type: "sendFailed" }),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Segmented role="tablist" label="Type of wish" options={modes} value={mode} onChange={chooseMode} disabled={busy} />

      <form
        action={formAction}
        onSubmit={(event) => {
          if (recorded) {
            sendRecording(event);
            return;
          }
          saveGuestName(String(new FormData(event.currentTarget).get("signedAs") ?? ""));
        }}
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
              required={mode === "text"}
              maxLength={1000}
              defaultValue={state.values?.message}
              placeholder="A blessing, a memory, or some advice for married life"
              aria-invalid={errors?.message ? true : undefined}
              aria-describedby={errors?.message ? "wish-error" : undefined}
            />
          </Field>
        </div>
        {recorded ? (
          <div role="tabpanel" aria-label={mode === "video" ? "Video" : "Voice note"} key={mode}>
            <Recorder kind={recordedKind} state={recorder} dispatch={dispatch} />
          </div>
        ) : null}

        <Field
          id="signed"
          label="Sign your wish"
          hint={nameError ? <span id="signed-error" className="text-ember-ink">{nameError}</span> : undefined}
        >
          <TextInput
            id="signed"
            name="signedAs"
            type="text"
            autoComplete="name"
            required
            maxLength={SIGNATURE_MAX_CHARACTERS}
            // Keyed so the remembered name fills in once it loads on the phone.
            key={savedName ?? "no-name"}
            defaultValue={state.values?.signedAs ?? savedName ?? ""}
            placeholder="Your name"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "signed-error" : undefined}
          />
        </Field>

        {!recorded && errors?.form ? (
          <p role="alert" className="m-0 text-center text-sm text-ember-ink">
            {errors.form}
          </p>
        ) : null}

        <PillButton type="submit" variant="cocoa" size="lg" block disabled={!canSend || busy}>
          {!recorded && pending ? "Sending…" : "Send my wish"}
        </PillButton>
      </form>
    </div>
  );
}

const SENT_WORDS: Record<WishKind, (name: string) => string> = {
  text: (name) => `${name}, your wish is on the wall below. Noblet and Nancy will treasure it.`,
  voice: (name) => `${name}, your voice note will be on the wall below in a moment. Noblet and Nancy will treasure it.`,
  video: (name) => `${name}, your video message will be on the wall below in a moment. Noblet and Nancy will treasure it.`,
};

function ThankYou({ name, kind, onAgain }: { name: string; kind: WishKind; onAgain: () => void }) {
  return (
    <div
      role="status"
      tabIndex={-1}
      ref={(element) => element?.focus()}
      className="flex animate-rise flex-col items-center gap-3 py-6 text-center outline-none"
    >
      <Halo icon="heart" size="xl" />
      <p className="m-0 font-script text-[46px] leading-[1.1]">Thank you</p>
      <p className="m-0 max-w-xs font-serif text-xl leading-relaxed text-mocha">{SENT_WORDS[kind](name)}</p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-6 gap-y-1">
        <a href="#wall-h" className="ember-link inline-flex min-h-11 items-center text-xs uppercase tracking-[0.18em] no-underline">
          See the wall
        </a>
        <button
          type="button"
          onClick={onAgain}
          className="ember-link inline-flex min-h-11 cursor-pointer items-center text-xs uppercase tracking-[0.18em]"
        >
          {kind === "text" ? "Write another" : "Record another"}
        </button>
      </div>
    </div>
  );
}
