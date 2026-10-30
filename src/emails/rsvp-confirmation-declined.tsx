import RsvpConfirmation, { type RsvpConfirmationProps } from "./rsvp-confirmation";
import { sampleDeclined } from "./components/sample";

/** For the preview server only: the confirmation for a guest who can come to none of the celebrations. */
export default function RsvpConfirmationDeclined(props: RsvpConfirmationProps) {
  return <RsvpConfirmation {...props} />;
}

RsvpConfirmationDeclined.PreviewProps = sampleDeclined satisfies RsvpConfirmationProps;
