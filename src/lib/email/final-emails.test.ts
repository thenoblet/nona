import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { FINAL_SUBJECTS, renderFinalEmail } from "./final-emails";

const siteUrl = "https://nobletxnancy.com";
const coming = { fullName: "Ama Owusu", answers: { ceremony: "yes", reception: "yes" } } as const;
const away = { fullName: "Kofi Mensah", answers: { ceremony: "no", reception: "no" } } as const;

describe("renderFinalEmail", () => {
  it("writes the details by name: the celebrations, who to call, getting there, where to stay", async () => {
    const mail = await renderFinalEmail("details", coming, contentDefaults, siteUrl, `${siteUrl}/my/token`);
    expect(mail.subject).toBe(FINAL_SUBJECTS.details);
    expect(mail.text).toContain("Dear Ama Owusu,");
    expect(mail.text).toContain("White wedding");
    expect(mail.text).toContain("Reception");
    for (const helper of contentDefaults.helpers) {
      expect(mail.text).toContain(helper.name);
      expect(mail.html).toContain(`tel:+233${helper.phone.replace(/\D/g, "").slice(1)}`);
    }
    expect(mail.text).toContain("Getting to Tepa");
    expect(mail.text).toContain("NewLove Guest House");
    expect(mail.html).toContain(`${siteUrl}/stay`);
    expect(mail.html).toContain(`${siteUrl}/my/token`);
    // Where to stay comes once, as the places themselves, not again as a travel card.
    expect(mail.text.match(/Where to stay/g)).toHaveLength(1);
  });

  it("leaves out the personal link without one, and the help card without helpers", async () => {
    const mail = await renderFinalEmail("details", coming, { ...contentDefaults, helpers: [] }, siteUrl);
    expect(mail.html).not.toContain("/my/");
    expect(mail.text).not.toContain("Need a hand");
  });

  it("thanks a guest who can't come: the live album and a wish, no live stream and no details", async () => {
    const mail = await renderFinalEmail("thanks", away, contentDefaults, siteUrl);
    expect(mail.subject).toBe(FINAL_SUBJECTS.thanks);
    expect(mail.text).toContain("Dear Kofi Mensah,");
    expect(mail.text).toContain("Saturday 5 December");
    expect(mail.text).toContain("live album");
    expect(mail.html).toContain(`${siteUrl}/album`);
    expect(mail.html).toContain(`${siteUrl}/wishes`);
    expect(mail.text.toLowerCase()).not.toContain("live stream");
    expect(mail.text).not.toContain(contentDefaults.helpers[0].phone);
    expect(mail.text).not.toContain("NewLove");
  });

  it("greets a name that isn't plain as a guest", async () => {
    const mail = await renderFinalEmail("thanks", { ...away, fullName: "Kofi http://spam.example" }, contentDefaults, siteUrl);
    expect(mail.text).toContain("Dear guest,");
  });
});
