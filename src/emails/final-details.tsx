import { Container, Head, Heading, Html, Link, Preview, Section, Text } from "react-email";
import { CelebrationCard, type ConfirmationCelebration } from "./components/CelebrationCard";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { InfoCard } from "./components/InfoCard";
import { OutlookFixedWidth } from "./components/OutlookOnly";
import { PersonalLinkCard } from "./components/PersonalLinkCard";
import { sampleReply } from "./components/sample";
import { clientStyles, colours, fontFaces, fonts } from "./components/theme";

export type FinalHelper = { name: string; phone: string; note?: string; callUrl: string; whatsappUrl: string };
export type FinalTravel = { title: string; lines: string[]; link?: { label: string; url: string } };
export type FinalStay = { name: string; price?: string; phone?: string; callUrl?: string; note?: string };

export type FinalDetailsProps = {
  /** The guest's name when it is a plain name; null greets them as "Dear guest". */
  guestName: string | null;
  /** The celebrations the guest is coming to. */
  celebrations: ConfirmationCelebration[];
  siteUrl: string;
  personalLink?: string | null;
  helpers: FinalHelper[];
  travel: FinalTravel[];
  stays: FinalStay[];
};

const INTRO =
  "Replies are closed, and yours is with us. Thank you for saying yes: it means so much to us. Here is everything you need for the day.";

const paragraph = { margin: 0, fontFamily: fonts.text, fontSize: "14px", lineHeight: "21px", color: colours.mocha } as const;
const name = { fontFamily: fonts.serif, fontStyle: "italic", fontSize: "18px", lineHeight: "22px", color: colours.cocoa } as const;
const link = { color: colours.emberInk, textDecoration: "none" } as const;
const smallCaps = {
  fontFamily: fonts.sans,
  fontSize: "10px",
  lineHeight: "16px",
  fontWeight: 500,
  letterSpacing: "0.26em",
  textTransform: "uppercase",
  color: colours.emberInk,
  textDecoration: "none",
} as const;

/**
 * The email the couple send everyone coming once replies close (from the admin's Emails page):
 * thanks by name, the celebrations they're coming to, who to call on the day, getting there, where
 * to stay and their personal link. Each part comes from the site text at the moment it is sent,
 * and a part with nothing in it is left out. Rendered by the final-email job, never in a request.
 */
export default function FinalDetails({ guestName, celebrations, siteUrl, personalLink, helpers, travel, stays }: FinalDetailsProps) {
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

              <Section tdClassName="nn-pad" style={{ padding: "4px 40px 0" }}>
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
                <Text style={{ ...paragraph, fontSize: "15px", lineHeight: "23px", textAlign: "center", margin: "6px auto 0", maxWidth: "430px" }}>
                  {INTRO}
                </Text>
              </Section>

              <Section tdClassName="nn-pad" style={{ padding: "20px 34px 0" }}>
                {celebrations.map((celebration) => (
                  <CelebrationCard key={celebration.id} celebration={celebration} />
                ))}
              </Section>

              {helpers.length > 0 ? (
                <InfoCard title="Need a hand on the day?">
                  <Text style={{ ...paragraph, margin: "0 0 10px" }}>
                    Lost on the way, looking for the venue, or anything else: call or WhatsApp one of these friends. We&apos;ll be away
                    from our phones.
                  </Text>
                  {helpers.map((helper) => (
                    <Text key={`${helper.name} ${helper.phone}`} style={{ ...paragraph, fontSize: "15px", lineHeight: "22px", margin: "0 0 8px" }}>
                      <span style={name}>{helper.name}</span>
                      <br />
                      <Link href={helper.callUrl} style={link}>
                        {helper.phone}
                      </Link>
                      <span style={{ color: colours.stone }}>{"  ·  "}</span>
                      <Link href={helper.whatsappUrl} style={link}>
                        WhatsApp
                      </Link>
                      {helper.note ? (
                        <>
                          <br />
                          <span style={{ fontSize: "13px" }}>{helper.note}</span>
                        </>
                      ) : null}
                    </Text>
                  ))}
                </InfoCard>
              ) : null}

              {travel.map((item) => (
                <InfoCard key={item.title} title={item.title}>
                  {item.lines.map((line) => (
                    <Text key={line} style={{ ...paragraph, margin: "0 0 6px" }}>
                      {line}
                    </Text>
                  ))}
                  {item.link ? (
                    <Link href={item.link.url} style={smallCaps}>
                      {item.link.label}
                    </Link>
                  ) : null}
                </InfoCard>
              ))}

              {stays.length > 0 ? (
                <InfoCard title="Where to stay">
                  <Text style={{ ...paragraph, margin: "0 0 10px" }}>Call ahead to book your room.</Text>
                  {stays.map((stay) => (
                    <Text key={stay.name} style={{ ...paragraph, margin: "0 0 8px" }}>
                      <span style={name}>{stay.name}</span>
                      <br />
                      {[stay.price, stay.note].filter(Boolean).join(" · ")}
                      {stay.phone && stay.callUrl ? (
                        <>
                          {stay.price || stay.note ? <span style={{ color: colours.stone }}>{"  ·  "}</span> : null}
                          <Link href={stay.callUrl} style={link}>
                            {stay.phone}
                          </Link>
                        </>
                      ) : null}
                    </Text>
                  ))}
                  <Link href={`${siteUrl}/stay`} style={smallCaps}>
                    See them on a map
                  </Link>
                </InfoCard>
              ) : null}

              {personalLink ? <PersonalLinkCard link={personalLink} /> : null}

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
                  See you in Tepa, <span style={{ whiteSpace: "nowrap" }}>Noblet &amp; Nancy</span>
                </Text>
                <Text
                  style={{
                    margin: "4px 0 0",
                    textAlign: "center",
                    fontFamily: fonts.sans,
                    fontSize: "10px",
                    lineHeight: "16px",
                    fontWeight: 500,
                    letterSpacing: "0.26em",
                    textTransform: "uppercase",
                    color: colours.mocha,
                  }}
                >
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

FinalDetails.PreviewProps = {
  guestName: sampleReply.guestName,
  celebrations: sampleReply.celebrations,
  siteUrl: sampleReply.siteUrl,
  personalLink: sampleReply.personalLink,
  helpers: [
    { name: "Daniel Afriyie", phone: "055 936 8495", callUrl: "tel:+233559368495", whatsappUrl: "https://wa.me/233559368495" },
    { name: "Edward Asamoah", phone: "024 417 3796", callUrl: "tel:+233244173796", whatsappUrl: "https://wa.me/233244173796" },
    { name: "Prince Brobbey", phone: "055 151 9910", callUrl: "tel:+233551519910", whatsappUrl: "https://wa.me/233551519910" },
  ],
  travel: [
    {
      title: "Getting to Tepa",
      lines: ["From Kumasi: about 2 hours by road, through Mankranso.", "From Accra: about 6 to 7 hours. Drive, or take a bus to Kumasi and a car on to Tepa."],
      link: { label: "Get directions", url: "https://www.google.com/maps/dir/?api=1&destination=7.019267,-2.145361" },
    },
  ],
  stays: [
    { name: "NewLove Guest House", price: "GH₵300 to 500 a night", phone: "024 459 0772", callUrl: "tel:+233244590772" },
    { name: "NewLove Guest House, Annex", price: "GH₵300 to 500 a night", phone: "024 459 0772", callUrl: "tel:+233244590772", note: "Book through the main house" },
    { name: "Jesus is Evergreen Hotel", price: "GH₵300 to 500 a night", phone: "055 756 8088", callUrl: "tel:+233557568088" },
  ],
} satisfies FinalDetailsProps;
