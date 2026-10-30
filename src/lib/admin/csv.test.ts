import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

const BOM = "\uFEFF";

describe("toCsv", () => {
  it("starts with a byte order mark so Excel reads Ɔ and Ɛ as UTF-8", () => {
    const csv = toCsv([["Akosua Ɔfori", "Ɛsi"]]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toBe(`${BOM}Akosua Ɔfori,Ɛsi\r\n`);
  });

  it("quotes a name with a comma and a quote, doubling the quote", () => {
    expect(toCsv([['Mensah, Kofi "KK"', "Accra"]])).toBe(`${BOM}"Mensah, Kofi ""KK""",Accra\r\n`);
  });

  it("quotes cells with line breaks", () => {
    expect(toCsv([["line one\nline two"]])).toBe(`${BOM}"line one\nline two"\r\n`);
  });

  it("ends every row with CRLF", () => {
    expect(toCsv([["Name", "Phone"], ["Ama Owusu", "024 000 0000"]])).toBe(
      `${BOM}Name,Phone\r\nAma Owusu,024 000 0000\r\n`,
    );
  });

  it("keeps an empty cell empty", () => {
    expect(toCsv([["Ama Owusu", "", "Yes"]])).toBe(`${BOM}Ama Owusu,,Yes\r\n`);
  });

  it("stops a song starting with = from running as a formula", () => {
    expect(toCsv([["Ama Owusu", "=HYPERLINK(\"http://example.com\")"]])).toBe(
      `${BOM}Ama Owusu,"'=HYPERLINK(""http://example.com"")"\r\n`,
    );
  });

  it("guards every cell that starts with =, +, -, @, a tab or a carriage return", () => {
    const csv = toCsv([["=SUM(A1)", "+1", "-1", "@x", "\tx", "\rx", "safe", "a=b"]]);
    expect(csv).toBe(`${BOM}'=SUM(A1),'+1,'-1,'@x,"'\tx","'\rx",safe,a=b\r\n`);
  });
});
