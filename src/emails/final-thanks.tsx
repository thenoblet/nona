import { Button, Container, Head, Heading, Html, Link, Preview, Section, Text } from "react-email";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { OutlookFixedWidth } from "./components/OutlookOnly";
import { clientStyles, colours, fontFaces, fonts } from "./components/theme";

export type FinalThanksProps = {
  /** The guest's name when it is a plain name; null greets them as "Dear guest". */
  guestName: string | null;
  siteUrl: string;
  /** The wedding day as the site writes it, e.g. "Saturday 5 December". */
  day: string;
};

const INTRO =
  "Replies are closed, and we have yours. Thank you for letting us know: we'll miss you on the day, and we're grateful you're with us in spirit.";

const paragraph = {
  margin: 0,
  fontFamily: fonts.text,
  fontSize: "15px",
  lineHeight: "23px",
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
 * The short thank-you the couple send guests who can't come, once replies close (from the admin's
 * Emails page): thanks by name, and the day through the guests' eyes in the live album, and a wish.
 * Rendered by the final-email job, never in a request.
 */
export default function FinalThanks({ guestName, siteUrl, day }: FinalThanksProps) {
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
        <Preview>{INTRO}</Preview>
        <Section style={{ backgroundColor: colours.blush, padding: "0 0 28px" }}>
          <OutlookFixedWidth width={600}>
            <Container style={{ maxWidth: "600px" }}>
              <Header siteUrl={siteUrl} />
              <Section tdClassName="nn-pad" style={{ padding: "4px 40px 0", textAlign: "center" }}>
                <Heading
                  as="h1"
                  style={{
                    margin: 0,
                    textAlign: "center",
                    fontFamily: fonts.serif,
                    fontStyle: "italic",
                    fontWeight: 500,
                    fontSize: "23px",
                    lineHeight: "28px",
                    color: colours.cocoa,
                  }}
                >
                  {`Dear ${guestName ?? "guest"},`}
                </Heading>
                <Text style={{ ...paragraph, margin: "6px auto 0", maxWidth: "430px" }}>{INTRO}</Text>
                <Text style={{ ...paragraph, margin: "14px auto 0", maxWidth: "430px" }}>
                  {`You can still share the day with us. On ${day}, see it through our guests' eyes in our live album, as they share their photos and videos, and leave us a wish.`}
                </Text>
                <Button
                  href={`${siteUrl}/album`}
                  style={{ ...smallCaps, marginTop: "18px", padding: "12px 24px", borderRadius: "999px", backgroundColor: colours.ember, color: colours.cocoa }}
                >
                  Open the live album
                </Button>
                <Text style={{ ...paragraph, margin: "12px 0 0" }}>
                  <Link href={`${siteUrl}/wishes`} style={{ ...smallCaps, color: colours.emberInk, textDecoration: "none" }}>
                    Leave us a wish
                  </Link>
                </Text>
              </Section>
              <Section tdClassName="nn-pad" style={{ padding: "24px 40px 0", textAlign: "center" }}>
                <Text
                  className="nn-sign"
                  style={{
                    margin: "6px 0 0",
                    textAlign: "center",
                    fontFamily: fonts.script,
                    fontStyle: "italic",
                    fontSize: "30px",
                    lineHeight: "38px",
                    color: colours.emberInk,
                  }}
                >
                  With love, <span style={{ whiteSpace: "nowrap" }}>Noblet &amp; Nancy</span>
                </Text>
                <Text style={{ ...smallCaps, margin: "4px 0 0", textAlign: "center", color: colours.mocha }}>Always &amp; Forever</Text>
                <Footer siteUrl={siteUrl} />
              </Section>
            </Container>
          </OutlookFixedWidth>
        </Section>
      </body>
    </Html>
  );
}

FinalThanks.PreviewProps = {
  guestName: "Kofi Mensah",
  siteUrl: "https://nobletxnancy.com",
  day: "Saturday 5 December",
} satisfies FinalThanksProps;
