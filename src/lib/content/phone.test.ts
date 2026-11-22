import { describe, expect, it } from "vitest";
import { telHref, whatsappHref } from "./phone";

describe("telHref", () => {
  it("dials a Ghana number with its country code", () => {
    expect(telHref("024 459 0772")).toBe("tel:+233244590772");
    expect(telHref("055 756 8088")).toBe("tel:+233557568088");
  });

  it("keeps a number typed with its own country code", () => {
    expect(telHref("+44 20 7946 0958")).toBe("tel:+442079460958");
    expect(telHref("+233 24 459 0772")).toBe("tel:+233244590772");
  });
});

describe("whatsappHref", () => {
  it("opens a chat with a Ghana number, with its country code", () => {
    expect(whatsappHref("055 936 8495")).toBe("https://wa.me/233559368495");
  });

  it("keeps a number typed with its own country code", () => {
    expect(whatsappHref("+44 20 7946 0958")).toBe("https://wa.me/442079460958");
  });

  it("writes a message in the chat, ready to send", () => {
    expect(whatsappHref("024 417 3796", "Hello & welcome")).toBe("https://wa.me/233244173796?text=Hello%20%26%20welcome");
  });
});
