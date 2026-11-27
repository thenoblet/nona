import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { builtinPhoto, type SlotPhoto } from "@/lib/site-images/photos";
import { HOST_SLOT_ID } from "@/lib/site-images/slots";
import { ProgrammeCelebration } from "@/components/programme/ProgrammeCelebration";
import { notStarted } from "@/components/today/day";
import { HostCard, Party } from "./Sections";

// Outside Next a static import is only its path, with no size or blur placeholder: give it both.
const builtin = builtinPhoto(HOST_SLOT_ID)!;
const photo: SlotPhoto = {
  kind: "builtin",
  ...builtin,
  image: { src: "/images/host/mc.jpg", width: 600, height: 800, blurDataURL: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" },
};
const host = contentDefaults.host;

describe("the MC's card", () => {
  it("names him, his role and what he does, with his photo", () => {
    const html = renderToStaticMarkup(createElement(HostCard, { host, photo }));
    expect(html).toContain("Your host for the day");
    expect(html).toContain("International MC");
    expect(html).toContain("Master of ceremonies");
    expect(html).toContain("He will guide you through the reception");
    expect(html).toContain('alt="International MC with a microphone"');
  });

  it("keeps the words without a photo or a line", () => {
    const html = renderToStaticMarkup(createElement(HostCard, { host: { name: "Kofi", role: "MC" }, photo: null }));
    expect(html).toContain("Kofi");
    expect(html).not.toContain("<img");
  });

  it("follows the wedding party unless he is hidden or not given", () => {
    const party = contentDefaults.party;
    const photos = { [HOST_SLOT_ID]: photo };
    expect(renderToStaticMarkup(createElement(Party, { party, photos, host }))).toContain("Your host for the day");
    expect(renderToStaticMarkup(createElement(Party, { party, photos, host: { ...host, hidden: true } }))).not.toContain(
      "Your host for the day",
    );
    expect(renderToStaticMarkup(createElement(Party, { party, photos }))).not.toContain("Your host for the day");
  });
});

describe("Hosted by, in the order of the day", () => {
  const reception = contentDefaults.celebrations.find((celebration) => celebration.id === "reception")!;
  const render = (receptionHost: { name: string; photo: SlotPhoto | null } | null) =>
    renderToStaticMarkup(
      createElement(ProgrammeCelebration, {
        celebration: reception,
        venues: contentDefaults.venues,
        items: [],
        standing: notStarted,
        host: receptionHost,
      }),
    );

  it("names the host beside a photo screen readers skip", () => {
    const html = render({ name: "International MC", photo });
    expect(html).toContain("Hosted by");
    expect(html).toContain("International MC");
    expect(html).toContain('alt=""');
  });

  it("shows nothing without a host", () => {
    expect(render(null)).not.toContain("Hosted by");
  });
});
