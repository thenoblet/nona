import { Button, Container, Head, Heading, Html, Preview, Section, Text } from "react-email";
import { CelebrationCard, type ConfirmationCelebration } from "./components/CelebrationCard";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { sampleReply } from "./components/sample";
import { clientStyles, colours, fontFaces, fonts } from "./components/theme";

export type { ConfirmationCelebration };

export type RsvpConfirmationProps = {
  /** The guest's name when it is a plain name; null greets them as "Dear guest". */
  guestName: string | null;
  /** Only the celebrations the guest answered, in the site's order. */
  celebrations: ConfirmationCelebration[];
  /** The site's address without a trailing slash, e.g. https://nobletxnancy.com. */
  siteUrl: string;
};

const paragraph = {
  margin: 0,
  fontFamily: fonts.sans,
  fontSize: "16px",
  lineHeight: "26px",
  textAlign: "center",
  color: colours.mocha,
} as const;

/**
 * The confirmation a guest gets after replying with an email address: their answer for each
 * celebration, Google Calendar links for the ones they're coming to (the calendar file is attached
 * beside them), and how to change the reply. Rendered by the confirmation job, never in a request.
 */
export default function RsvpConfirmation({ guestName, celebrations, siteUrl }: RsvpConfirmationProps) {
  const comingToAny = celebrations.some((celebration) => celebration.attending);
  const intro = comingToAny
    ? "Thank you for your reply. Here is what we have for you."
    : "Thank you for letting us know. We'll miss you, and we'll be thinking of you.";

  return (
    <Html lang="en">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <meta name="format-detection" content="telephone=no, date=no, address=no, email=no" />
        <style dangerouslySetInnerHTML={{ __html: fontFaces }} />
        <style dangerouslySetInnerHTML={{ __html: clientStyles }} />
      </Head>
      <body className="nn-page" style={{ margin: 0, padding: 0, backgroundColor: colours.blush }}>
        <Preview>{intro}</Preview>
        <Section className="nn-page" style={{ backgroundColor: colours.blush, padding: "36px 14px 40px" }}>
          <Container style={{ maxWidth: "600px" }}>
            <Header />
            <Heading
              as="h1"
              className="nn-ink"
              style={{
                margin: "0 0 10px",
                textAlign: "center",
                fontFamily: fonts.serif,
                fontStyle: "italic",
                fontWeight: 500,
                fontSize: "30px",
                lineHeight: "38px",
                color: colours.cocoa,
              }}
            >
              {`Dear ${guestName ?? "guest"},`}
            </Heading>
            <Text className="nn-soft" style={paragraph}>
              {intro}
            </Text>

            <Section style={{ paddingTop: "14px" }}>
              {celebrations.map((celebration) => (
                <CelebrationCard key={celebration.id} celebration={celebration} />
              ))}
            </Section>

            {comingToAny ? (
              <Text className="nn-soft" style={{ ...paragraph, margin: "18px 0 0", fontSize: "14px", lineHeight: "22px" }}>
                For Apple, Outlook and other calendars, open the calendar file attached to this email.
              </Text>
            ) : null}

            <Text className="nn-soft" style={{ ...paragraph, margin: "34px 0 0" }}>
              Need to change something? Send a new reply with the same name and phone or email.
            </Text>
            <Section style={{ paddingTop: "18px", textAlign: "center" }}>
              <Button
                href={`${siteUrl}/rsvp`}
                className="nn-button"
                style={{
                  padding: "15px 30px",
                  borderRadius: "999px",
                  backgroundColor: colours.cocoa,
                  color: colours.white,
                  fontFamily: fonts.sans,
                  fontSize: "12px",
                  fontWeight: 500,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                }}
              >
                Change my reply
              </Button>
            </Section>

            <Text
              className="nn-accent"
              style={{
                margin: "34px 0 0",
                textAlign: "center",
                fontFamily: fonts.script,
                fontStyle: "italic",
                fontSize: "30px",
                lineHeight: "40px",
                color: colours.emberInk,
              }}
            >
              {/* Too long for a narrow screen, it breaks after "With love,". */}
              With love, <span style={{ whiteSpace: "nowrap" }}>Noblet &amp; Nancy</span>
            </Text>

            <Footer siteUrl={siteUrl} />
          </Container>
        </Section>
      </body>
    </Html>
  );
}

RsvpConfirmation.PreviewProps = sampleReply satisfies RsvpConfirmationProps;
