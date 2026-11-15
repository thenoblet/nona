import { crc32 as nodeCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { columnName, crc32, toXlsx } from "./xlsx";

/** The files in a stored zip, read back from its central directory. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let position = view.getUint32(end + 16, true);
  const files = new Map<string, string>();
  const decoder = new TextDecoder();
  for (let file = 0; file < count; file++) {
    expect(view.getUint32(position, true)).toBe(0x02014b50);
    expect(view.getUint16(position + 10, true)).toBe(0); // stored
    const checksum = view.getUint32(position + 16, true);
    const size = view.getUint32(position + 20, true);
    const nameLength = view.getUint16(position + 28, true);
    const offset = view.getUint32(position + 42, true);
    const name = decoder.decode(bytes.slice(position + 46, position + 46 + nameLength));
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    const dataStart = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const data = bytes.slice(dataStart, dataStart + size);
    expect(crc32(data)).toBe(checksum);
    files.set(name, decoder.decode(data));
    position += 46 + nameLength;
  }
  return files;
}

describe("toXlsx", () => {
  const rows = [
    ["Name", "Phone", "Song"],
    ["Ama Owusu", "024 000 0000", "=Odo"],
    ["Kofi & Efua <Mensah>", "+233 55 111 2222", 'Say "yes"\u0007'],
  ];

  it("is a zip of the workbook's parts that Excel needs", () => {
    const files = unzip(toXlsx(rows, "Replies"));
    expect([...files.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(files.get("xl/workbook.xml")).toContain('<sheet name="Replies" sheetId="1" r:id="rId1"/>');
  });

  it("writes every cell as text, escaped, so numbers keep their 0 and nothing runs as a formula", () => {
    const sheet = unzip(toXlsx(rows)).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">024 000 0000</t></is></c>');
    expect(sheet).toContain('<c r="C2" t="inlineStr"><is><t xml:space="preserve">=Odo</t></is></c>');
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("Kofi &amp; Efua &lt;Mensah&gt;");
    expect(sheet).toContain("Say &quot;yes&quot;</t>");
  });

  it("makes the header bold and frozen, with filters over the rows", () => {
    const sheet = unzip(toXlsx(rows)).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1">');
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is>');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A1:C3"/>');
  });

  it("gives the same bytes for the same rows", () => {
    expect(toXlsx(rows)).toEqual(toXlsx(rows));
  });
});

describe("columnName", () => {
  it("names columns as spreadsheets do", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });
});

describe("crc32", () => {
  it("matches Node's", () => {
    const bytes = new TextEncoder().encode("Noblet & Nancy, 5 December 2026 ✓");
    expect(crc32(bytes)).toBe(nodeCrc32(bytes));
  });
});
