import { formatDuration, localTimestamp, makeClientExportRows, spreadsheetText } from './reportCsv.ts';
import type { ExportEntry, ExportRow } from './reportCsv.ts';

export type XlsxMeta = {
  client: string;
  from: string;
  through: string;
  zone: string;
};

type ZipFileInput = {
  name: string;
  data: Uint8Array;
};

export type XlsxSaveResult = 'saved' | 'cancelled';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function xmlClean(value: string): string {
  // Strip C0 control chars disallowed in XML 1.0 while keeping \t, \n, \r.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu, '');
}

function xmlEscape(value: string): string {
  return xmlClean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnName(index: number): string {
  let current = index + 1;
  let label = '';
  while (current > 0) {
    const rem = (current - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    current = Math.floor((current - 1) / 26);
  }
  return label;
}

function cellRef(rowIndex1Based: number, colIndex0Based: number): string {
  return `${columnName(colIndex0Based)}${rowIndex1Based}`;
}

function inlineTextCell(ref: string, value: string, styleIndex = 0, protectFormula = true): string {
  const safeValue = protectFormula ? spreadsheetText(value) : value;
  return `<c r="${ref}" t="inlineStr" s="${styleIndex}"><is><t xml:space="preserve">${xmlEscape(safeValue)}</t></is></c>`;
}

function numberCell(ref: string, value: number, styleIndex = 0): string {
  if (!Number.isFinite(value)) throw new Error('Wartość liczbowa eksportu XLSX jest nieprawidłowa.');
  return `<c r="${ref}" t="n" s="${styleIndex}"><v>${value}</v></c>`;
}

function buildZipStore(files: readonly ZipFileInput[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  // Deterministic DOS timestamp: 2026-01-01 00:00:00
  const dosTime = 0x0000;
  const dosDate = 0x5c21;

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(localHeader.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    ldv.setUint16(8, 0, true); // STORE (no compression)
    ldv.setUint16(10, dosTime, true);
    ldv.setUint16(12, dosDate, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, data.length, true);
    ldv.setUint32(22, data.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(centralHeader.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, dosTime, true);
    cdv.setUint16(14, dosDate, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, data);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, 0, true);

  const totalLength = offset + centralSize + eocd.length;
  const archive = new Uint8Array(totalLength);
  let cursor = 0;
  for (const part of localParts) { archive.set(part, cursor); cursor += part.length; }
  for (const part of centralParts) { archive.set(part, cursor); cursor += part.length; }
  archive.set(eocd, cursor);
  return archive;
}

function assertValidMeta(meta: XlsxMeta, rows: readonly ExportRow[]): void {
  if (!meta.client || !meta.from || !meta.through || !meta.zone) {
    throw new Error('Brak wymaganych metadanych raportu do eksportu XLSX.');
  }
  for (const row of rows) {
    if (!Number.isSafeInteger(row.source.id) || row.source.id <= 0) {
      throw new Error('Wpis eksportu XLSX ma nieprawidłowy identyfikator.');
    }
    if (row.source.client !== meta.client) {
      throw new Error('Dane eksportu XLSX zawierają wpisy innego klienta.');
    }
  }
}

function buildEntriesSheet(rows: readonly ExportRow[], zone: string): string {
  const headers = [
    'ID wpisu',
    'Klient',
    'Projekt',
    'Zadanie',
    'Opis',
    'Start',
    'Koniec',
    'Rozliczalność',
    'Czas całkowity w sekundach',
    'Czas całkowity HH:MM:SS',
    'Czas w wybranym okresie w sekundach',
    'Czas w wybranym okresie HH:MM:SS',
  ];
  const lastRow = rows.length + 1;
  const headerXml = `<row r="1">${headers.map((header, col) => inlineTextCell(cellRef(1, col), header, 1, false)).join('')}</row>`;
  const bodyXml = rows.map(({ source: entry, contribution }, idx) => {
    const r = idx + 2;
    const cells = [
      numberCell(cellRef(r, 0), entry.id, 2),
      inlineTextCell(cellRef(r, 1), entry.client, 0, true),
      inlineTextCell(cellRef(r, 2), entry.project, 0, true),
      inlineTextCell(cellRef(r, 3), entry.task, 0, true),
      inlineTextCell(cellRef(r, 4), entry.description, 0, true),
      inlineTextCell(cellRef(r, 5), localTimestamp(entry.started_at, zone), 0, false),
      inlineTextCell(cellRef(r, 6), localTimestamp(entry.ended_at, zone), 0, false),
      inlineTextCell(cellRef(r, 7), entry.billable ? 'Tak' : 'Nie', 0, false),
      numberCell(cellRef(r, 8), entry.duration_seconds, 2),
      inlineTextCell(cellRef(r, 9), formatDuration(entry.duration_seconds), 0, false),
      numberCell(cellRef(r, 10), contribution, 2),
      inlineTextCell(cellRef(r, 11), formatDuration(contribution), 0, false),
    ];
    return `<row r="${r}">${cells.join('')}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:L${lastRow}"/>
  <cols>
    <col min="1" max="1" width="12" customWidth="1"/>
    <col min="2" max="4" width="22" customWidth="1"/>
    <col min="5" max="5" width="36" customWidth="1"/>
    <col min="6" max="7" width="26" customWidth="1"/>
    <col min="8" max="8" width="15" customWidth="1"/>
    <col min="9" max="12" width="20" customWidth="1"/>
  </cols>
  <sheetData>${headerXml}${bodyXml}</sheetData>
</worksheet>`;
}

function buildSummarySheet(rows: readonly ExportRow[], meta: XlsxMeta): string {
  const totalSeconds = rows.reduce((sum, row) => sum + row.contribution, 0);
  const byProject = new Map<string, number>();
  for (const row of rows) {
    byProject.set(row.source.project, (byProject.get(row.source.project) ?? 0) + row.contribution);
  }
  const summaryRows: string[] = [
    `<row r="1">${inlineTextCell('A1', 'Parametr', 1, false)}${inlineTextCell('B1', 'Wartość', 1, false)}</row>`,
    `<row r="2">${inlineTextCell('A2', 'Klient', 0, false)}${inlineTextCell('B2', meta.client, 0, true)}</row>`,
    `<row r="3">${inlineTextCell('A3', 'Okres od', 0, false)}${inlineTextCell('B3', meta.from, 0, false)}</row>`,
    `<row r="4">${inlineTextCell('A4', 'Okres do', 0, false)}${inlineTextCell('B4', meta.through, 0, false)}</row>`,
    `<row r="5">${inlineTextCell('A5', 'Strefa czasowa', 0, false)}${inlineTextCell('B5', meta.zone, 0, false)}</row>`,
    `<row r="6">${inlineTextCell('A6', 'Liczba wpisów', 0, false)}${numberCell('B6', rows.length, 2)}</row>`,
    `<row r="7">${inlineTextCell('A7', 'Suma w okresie (sekundy)', 0, false)}${numberCell('B7', totalSeconds, 2)}</row>`,
    `<row r="8">${inlineTextCell('A8', 'Suma w okresie (HH:MM:SS)', 0, false)}${inlineTextCell('B8', formatDuration(totalSeconds), 0, false)}</row>`,
    `<row r="9">${inlineTextCell('A9', 'Czas arkusza [h]:mm:ss', 0, false)}${numberCell('B9', totalSeconds / 86400, 3)}</row>`,
  ];
  let rowNum = 11;
  summaryRows.push(`<row r="${rowNum}">${inlineTextCell(`A${rowNum}`, 'Projekt', 1, false)}${inlineTextCell(`B${rowNum}`, 'Sekundy w okresie', 1, false)}${inlineTextCell(`C${rowNum}`, 'Czas HH:MM:SS', 1, false)}</row>`);
  for (const [project, seconds] of [...byProject.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pl'))) {
    rowNum += 1;
    summaryRows.push(`<row r="${rowNum}">${inlineTextCell(`A${rowNum}`, project, 0, true)}${numberCell(`B${rowNum}`, seconds, 2)}${inlineTextCell(`C${rowNum}`, formatDuration(seconds), 0, false)}</row>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:C${rowNum}"/>
  <cols>
    <col min="1" max="1" width="28" customWidth="1"/>
    <col min="2" max="3" width="26" customWidth="1"/>
  </cols>
  <sheetData>${summaryRows.join('')}</sheetData>
</worksheet>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Wpisy" sheetId="1" r:id="rId1"/>
    <sheet name="Podsumowanie" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="[h]:mm:ss"/>
  </numFmts>
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`;

export function exportXlsx(rows: readonly ExportRow[], meta: XlsxMeta): Uint8Array {
  assertValidMeta(meta, rows);
  const files: ZipFileInput[] = [
    { name: '[Content_Types].xml', data: textEncoder.encode(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: textEncoder.encode(ROOT_RELS_XML) },
    { name: 'xl/_rels/workbook.xml.rels', data: textEncoder.encode(WORKBOOK_RELS_XML) },
    { name: 'xl/workbook.xml', data: textEncoder.encode(WORKBOOK_XML) },
    { name: 'xl/styles.xml', data: textEncoder.encode(STYLES_XML) },
    { name: 'xl/worksheets/sheet1.xml', data: textEncoder.encode(buildEntriesSheet(rows, meta.zone)) },
    { name: 'xl/worksheets/sheet2.xml', data: textEncoder.encode(buildSummarySheet(rows, meta)) },
  ];
  return buildZipStore(files);
}

export function exportClientXlsxFromEntries(entries: ExportEntry[], meta: XlsxMeta): Uint8Array {
  const rows = makeClientExportRows(entries, meta.client, meta.from, meta.through, meta.zone);
  return exportXlsx(rows, meta);
}

export async function writeXlsxAtomically(
  rows: readonly ExportRow[],
  meta: XlsxMeta,
  writer: (bytes: Uint8Array) => Promise<XlsxSaveResult>,
): Promise<XlsxSaveResult> {
  // Generate and validate the whole workbook in memory before opening or writing any target file,
  // so cancellation or validation error never leaves a 0-byte or half-written file behind.
  const bytes = exportXlsx(rows, meta);
  if (bytes.length === 0) throw new Error('Wygenerowany plik XLSX jest pusty.');
  return writer(bytes);
}

export function inspectZipStore(bytes: Uint8Array): Map<string, string> {
  if (bytes.length < 22) throw new Error('Plik ZIP/XLSX jest za krótki.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Brak rekordu EOCD w pliku XLSX.');
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const out = new Map<string, string>();
  let cursor = cdOffset;
  for (let idx = 0; idx < totalEntries; idx++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Uszkodzony nagłówek central directory ZIP.');
    const method = view.getUint16(cursor + 10, true);
    if (method !== 0) throw new Error(`Nieobsługiwana metoda kompresji ZIP: ${method}.`);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = textDecoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Uszkodzony nagłówek lokalny dla ${name}.`);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const payload = bytes.subarray(dataStart, dataStart + size);
    if (payload.length !== size) throw new Error(`Niekompletne dane ZIP dla ${name}.`);
    if (crc32(payload) !== expectedCrc) throw new Error(`Nieprawidłowa suma kontrolna CRC32 dla ${name}.`);
    out.set(name, textDecoder.decode(payload));
  }
  return out;
}
