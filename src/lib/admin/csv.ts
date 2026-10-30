/** Spreadsheets run a cell starting with one of these as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;
/** Cells holding one of these are quoted (RFC 4180, plus tabs, which some imports split on). */
const NEEDS_QUOTES = /[",\r\n\t]/;

function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * RFC 4180 CSV: quoted cells with doubled quotes and CRLF line endings. A UTF-8 byte order mark
 * comes first so Excel shows Ɔ and Ɛ, and no cell can start a spreadsheet formula.
 */
export function toCsv(rows: string[][]): string {
  return `﻿${rows.map((row) => `${row.map(csvCell).join(",")}\r\n`).join("")}`;
}
