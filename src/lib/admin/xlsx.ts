/**
 * A one-sheet Excel workbook (.xlsx) from rows of text, with no library: the header row bold and
 * frozen with filters on it, columns sized to their text, and every cell plain text, so a phone
 * number keeps its leading 0 and nothing a guest typed can run as a formula.
 *
 * An .xlsx file is a zip of a few XML files. They are stored, not compressed: a sheet of replies
 * is a few hundred kilobytes at most, so writing it is quick string work that never ties up the
 * server, and Excel, Numbers and Google Sheets open stored zips like any other.
 */

const encoder = new TextEncoder();

/** XML 1.0 forbids most control characters, and Excel refuses a file that has one. */
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** "A" for the first column, "Z", "AA" and so on after it. */
export function columnName(columnIndex: number): string {
  let name = "";
  for (let remaining = columnIndex + 1; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
    name = String.fromCharCode(65 + ((remaining - 1) % 26)) + name;
  }
  return name;
}

/** Wide enough for each column's longest line, within reason. */
function columnWidths(rows: string[][]): number[] {
  const count = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: count }, (_, columnIndex) => {
    const longest = Math.max(0, ...rows.map((row) => Math.max(0, ...(row[columnIndex] ?? "").split("\n").map((line) => line.length))));
    return Math.min(60, Math.max(10, longest + 2));
  });
}

function sheetXml(rows: string[][]): string {
  const widths = columnWidths(rows);
  const lastCell = `${columnName(Math.max(widths.length - 1, 0))}${Math.max(rows.length, 1)}`;
  const columns = widths.map((width, columnIndex) => `<col min="${columnIndex + 1}" max="${columnIndex + 1}" width="${width}" customWidth="1"/>`).join("");
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
          const style = rowIndex === 0 ? ' s="1"' : "";
          return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    (columns ? `<cols>${columns}</cols>` : "") +
    `<sheetData>${body}</sheetData>` +
    (rows.length > 0 && widths.length > 0 ? `<autoFilter ref="A1:${lastCell}"/>` : "") +
    "</worksheet>"
  );
}

/** Sheet names: up to 31 characters, none of : \ / ? * [ ]. */
function sheetName(name: string): string {
  return escapeXml(name.replace(/[:\\/?*[\]]/g, " ").slice(0, 31).trim() || "Sheet1");
}

function workbookFiles(rows: string[][], name: string): [string, string][] {
  return [
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        "</Types>",
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    ],
    [
      "xl/workbook.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${sheetName(name)}" sheetId="1" r:id="rId1"/></sheets>` +
        // The header row's filter needs this hidden name, or Excel repairs the file on opening.
        (rows.length > 0 && rows[0].length > 0
          ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${sheetName(name).replaceAll("'", "''")}'!$A$1:$${columnName(Math.max(...rows.map((row) => row.length)) - 1)}$${rows.length}</definedName></definedNames>`
          : "") +
        "</workbook>",
    ],
    [
      "xl/_rels/workbook.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        "</Relationships>",
    ],
    [
      "xl/styles.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        "</styleSheet>",
    ],
    ["xl/worksheets/sheet1.xml", sheetXml(rows)],
  ];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** The zip format's checksum of each file. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip of the files as they are (stored, method 0), dated 1 January 1980 so the bytes never vary. */
function storedZip(files: [string, string][]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of files) {
    const name = encoder.encode(path);
    const data = encoder.encode(text);
    const checksum = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed: 2.0
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, 0, true); // time 00:00
    local.setUint16(12, 0x0021, true); // date 1980-01-01
    local.setUint32(14, checksum, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 0x0021, true);
    central.setUint32(16, checksum, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    directory.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const directorySize = directory.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...directory, new Uint8Array(end.buffer)];
  const output = new Uint8Array(all.reduce((total, part) => total + part.length, 0));
  let position = 0;
  for (const part of all) {
    output.set(part, position);
    position += part.length;
  }
  return output;
}

/** The rows as an .xlsx workbook with one sheet; the first row is the header. */
export function toXlsx(rows: string[][], name = "Sheet1"): Uint8Array<ArrayBuffer> {
  return storedZip(workbookFiles(rows, name));
}
