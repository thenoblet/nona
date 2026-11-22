import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { whatsappMessage } from "./whatsapp";

const siteUrl = "https://nobletxnancy.com";

describe("whatsappMessage", () => {
  it("writes the details as WhatsApp text, by the name the guest typed", () => {
    const message = whatsappMessage(
      "details",
      { fullName: " Kofi Mensah ", answers: { ceremony: "yes" } },
      contentDefaults,
      siteUrl,
      `${siteUrl}/my/token`,
    );
    expect(message.startsWith("Dear Kofi Mensah,\n\n")).toBe(true);
    expect(message).toContain("*White wedding*: Saturday 5 December");
    expect(message).not.toContain("*Reception*");
    expect(message).toContain("Daniel Afriyie: 055 936 8495");
    expect(message).toContain("*Getting to Tepa*");
    expect(message).toContain("NewLove Guest House, 024 459 0772");
    expect(message).toContain(`${siteUrl}/my/token`);
    expect(message.endsWith("See you in Tepa,\nNoblet & Nancy")).toBe(true);
  });

  it("thanks a guest who can't come with the live album and a wish, and nothing else", () => {
    const message = whatsappMessage("thanks", { fullName: "Yaw", answers: { ceremony: "no" } }, contentDefaults, siteUrl);
    expect(message).toContain(`${siteUrl}/album`);
    expect(message).toContain(`${siteUrl}/wishes`);
    expect(message).not.toContain("Daniel");
    expect(message.toLowerCase()).not.toContain("live stream");
  });
});
