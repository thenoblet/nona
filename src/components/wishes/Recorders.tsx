import { Icon } from "@/components/ui/Icon";

/*
 * Recording UI only.
 * TODO: record with MediaRecorder (voice up to 60 s, video up to 30 s on the front
 * camera), let the guest play it back, then upload the file to S3 and send the wish.
 */

export function VoiceRecorder() {
  return (
    <div className="flex flex-col items-center gap-4 pt-5.5 pb-3">
      <button
        type="button"
        aria-label="Start recording a voice note"
        className="press flex size-23 cursor-pointer items-center justify-center rounded-full bg-ember text-cocoa shadow-[var(--shadow-pill-ember)] animate-seal-pulse"
      >
        <Icon name="mic" size={32} />
      </button>
      <p className="m-0 font-serif text-[19px] text-mocha italic">Tap to record · up to 60 seconds</p>
    </div>
  );
}

export function VideoRecorder() {
  return (
    <div className="relative flex aspect-[4/5] flex-col items-center justify-end gap-3.5 overflow-hidden rounded-[var(--radius-paper)] bg-cocoa pb-7 text-white">
      <span aria-hidden className="absolute inset-4.5 rounded-[2px] border border-ember/40" />
      <p className="relative m-0 font-serif text-[19px] text-mist italic">Up to 30 seconds · front camera</p>
      <button
        type="button"
        aria-label="Start recording a video message"
        className="press relative size-18 cursor-pointer rounded-full border-4 border-white bg-ember shadow-[0_6px_16px_rgb(0_0_0/0.3)]"
      />
    </div>
  );
}
