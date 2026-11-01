import { Button, Column, Container, Head, Heading, Html, Preview, Row, Section, Text } from "react-email";
import { CelebrationCard, type ConfirmationCelebration } from "./components/CelebrationCard";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { OutlookFixedWidth } from "./components/OutlookOnly";
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
  /**
   * The guest's personal link (https://…/my/<token>), shown only to a guest coming to at least one
   * celebration; null or left out for a reply sent before personal links.
   */
  personalLink?: string | null;
};

const paragraph = {
  margin: 0,
  fontFamily: fonts.text,
  fontSize: "17px",
  lineHeight: "28px",
  textAlign: "center",
  color: colours.mocha,
} as const;

const smallCaps = {
  fontFamily: fonts.sans,
  fontSize: "10px",
  lineHeight: "16px",
  fontWeight: 500,
  letterSpacing: "0.26em",
  textTransform: "uppercase",
} as const;

/**
 * The confirmation a guest gets after replying with an email address, as a keepsake: the couple's
 * photo fading into a blush page, the greeting, a ticket for each celebration they answered
 * (Google Calendar links for the ones they're coming to, the calendar file attached beside them),
 * for a guest who is coming their personal link for the album, how to change the reply and the
 * couple's sign-off. Rendered by the confirmation job, never in a request.
 */
export default function RsvpConfirmation({ guestName, celebrations, siteUrl, personalLink }: RsvpConfirmationProps) {
  const comingToAny = celebrations.some((celebration) => celebration.attending);
  const intro = comingToAny
    ? "Thank you for your reply. We can't wait to celebrate with you. Here is what we have for you."
    : "Thank you for letting us know. We'll miss you, and we'll be thinking of you.";

  return (
    <Html lang="en">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light" />
        <meta name="format-detection" content="telephone=no, date=no, address=no, email=no" />
        <style dangerouslySetInnerHTML={{ __html: fontFaces }} />
        <style dangerouslySetInnerHTML={{ __html: clientStyles }} />
      </Head>
      <body style={{ margin: 0, padding: 0, backgroundColor: colours.blush }}>
        <Preview>{intro}</Preview>
        {/* No side margin: the header runs edge to edge and its photo fades into this same blush. */}
        <Section style={{ backgroundColor: colours.blush, padding: "0 0 44px" }}>
          {/* Classic Outlook for Windows ignores max-width: there, a 600 px table holds the email's width. */}
          <OutlookFixedWidth width={600}>
            <Container style={{ maxWidth: "600px" }}>
              <Header siteUrl={siteUrl} />

              <Section className="nn-pad" style={{ padding: "4px 40px 0" }}>
                <Heading
                  as="h1"
                  style={{
                    margin: 0,
                    textAlign: "center",
                    fontFamily: fonts.serif,
                    fontStyle: "italic",
                    fontWeight: 500,
                    fontSize: "26px",
                    lineHeight: "32px",
                    color: colours.cocoa,
                  }}
                >
                  {`Dear ${guestName ?? "guest"},`}
                </Heading>
                <Text style={{ ...paragraph, margin: "10px auto 0", maxWidth: "440px" }}>{intro}</Text>
              </Section>

              <Section className="nn-pad" style={{ padding: "32px 34px 0" }}>
                {celebrations.map((celebration) => (
                  <CelebrationCard key={celebration.id} celebration={celebration} />
                ))}
                {comingToAny ? (
                  <Text style={{ ...paragraph, margin: "6px 0 0", fontSize: "14px", lineHeight: "22px", fontStyle: "italic" }}>
                    For Apple, Outlook and other calendars, open the calendar file attached to this email.
                  </Text>
                ) : null}
              </Section>

              {comingToAny && personalLink ? <PersonalLinkCard link={personalLink} /> : null}

              <Section className="nn-pad" style={{ padding: "36px 40px 0", textAlign: "center" }}>
                <Text style={{ ...paragraph, margin: "0 0 20px", fontSize: "16px", lineHeight: "26px" }}>
                  Need to change something? Send a new reply with the same name and phone or email.
                </Text>
                <Button
                  href={`${siteUrl}/rsvp`}
                  style={{
                    ...smallCaps,
                    fontSize: "11px",
                    padding: "16px 32px",
                    borderRadius: "999px",
                    backgroundColor: colours.cocoa,
                    color: colours.white,
                  }}
                >
                  Change my reply
                </Button>
                <Text
                  style={{
                    margin: "42px 0 0",
                    textAlign: "center",
                    fontFamily: fonts.script,
                    fontStyle: "italic",
                    fontSize: "36px",
                    lineHeight: "46px",
                    color: colours.emberInk,
                  }}
                >
                  {/* Too long for a narrow screen, it breaks after "With love,". */}
                  With love, <span style={{ whiteSpace: "nowrap" }}>Noblet &amp; Nancy</span>
                </Text>
                <Text style={{ ...smallCaps, margin: "10px 0 0", textAlign: "center", color: colours.mocha }}>
                  Always &amp; Forever
                </Text>
                <Footer siteUrl={siteUrl} />
              </Section>
            </Container>
          </OutlookFixedWidth>
        </Section>
      </body>
    </Html>
  );
}

/**
 * The guest's personal link for the day, as a card like the album's own "Your personal link": the
 * same name, so the guest knows it again there, and a button that opens it. The plain text keeps
 * the heading, the line and the link's address.
 */
function PersonalLinkCard({ link }: { link: string }) {
  return (
    <Section className="nn-pad" style={{ padding: "22px 34px 0" }}>
      <Section
        style={{
          backgroundColor: colours.white,
          border: `1px solid ${colours.ticket}`,
          borderRadius: "14px",
          borderCollapse: "separate",
        }}
      >
        <Row>
          <Column className="nn-ticket" style={{ padding: "24px 28px 26px", textAlign: "center" }}>
            <Heading
              as="h2"
              style={{
                margin: 0,
                textAlign: "center",
                fontFamily: fonts.serif,
                fontStyle: "italic",
                fontWeight: 500,
                fontSize: "25px",
                lineHeight: "30px",
                color: colours.cocoa,
              }}
            >
              Your personal link
            </Heading>
            <Text style={{ ...paragraph, margin: "8px auto 18px", maxWidth: "460px", fontSize: "16px", lineHeight: "26px" }}>
              Use this link on the day to keep your photos together.
            </Text>
            <Button
              href={link}
              style={{
                ...smallCaps,
                fontSize: "11px",
                padding: "15px 30px",
                borderRadius: "999px",
                backgroundColor: colours.ember,
                color: colours.cocoa,
              }}
            >
              Open my link
            </Button>
          </Column>
        </Row>
      </Section>
    </Section>
  );
}

RsvpConfirmation.PreviewProps = sampleReply satisfies RsvpConfirmationProps;
