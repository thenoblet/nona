import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelpCard } from "./HelpCard";

const render = (helpers: Parameters<typeof HelpCard>[0]["helpers"]) => renderToStaticMarkup(createElement(HelpCard, { helpers }));

describe("HelpCard", () => {
  it("lists each helper with Call and WhatsApp, and a note on what they help with", () => {
    const html = render([{ name: "Daniel Afriyie", phone: "055 936 8495", note: "Directions and parking" }]);
    expect(html).toContain('href="tel:+233559368495"');
    expect(html).toContain('aria-label="Call Daniel Afriyie, 055 936 8495"');
    expect(html).toContain('href="https://wa.me/233559368495"');
    expect(html).toContain("Directions and parking");
  });

  it("shows nothing when the couple have no helpers", () => {
    expect(render([])).toBe("");
  });
});
