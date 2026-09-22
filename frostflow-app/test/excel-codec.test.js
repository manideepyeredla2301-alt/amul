'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('../vendor/jszip.min.js');
const { readWorkbook, writeWorkbook, readCsv, LIMITS } = require('../src/excel-codec');
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

async function externalWorkbook({ cells = '<c r="A1" t="inlineStr"><is><t>SKU</t></is></c>', rows, shared, styles, date1904 = false, extra = {} } = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('xl/workbook.xml', `<workbook xmlns="${NS}" xmlns:r="${REL}"><workbookPr date1904="${date1904 ? 1 : 0}"/><sheets><sheet name="External" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/data.xml"/>${shared ? `<Relationship Id="rIdShared" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` : ''}${styles ? `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>` : ''}</Relationships>`);
  zip.file('xl/worksheets/data.xml', `<worksheet xmlns="${NS}"><sheetData>${rows || `<row r="1">${cells}</row>`}</sheetData></worksheet>`);
  if (shared) zip.file('xl/sharedStrings.xml', shared);
  if (styles) zip.file('xl/styles.xml', styles);
  for (const [name, content] of Object.entries(extra)) zip.file(name, content, { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('true XLSX round trip preserves identifiers, INR amounts, Unicode, dates and safe literal formula-like text', async () => {
  const rows = [
    ['00123', 'Vanilla, "Family"\n500 ml', 25, 49.95, '2026-09-10', '=HYPERLINK("https://example.invalid","click")', true],
    ['+918888888888', 'कुल्फी ₹', 0, 0, '2027-01-02', '_x0041_', false],
  ];
  const bytes = await writeWorkbook([{ name: 'Inventory', headers: ['SKU', 'Product', 'Units', 'Retail price', 'Expiry', 'Notes', 'Active'], rows, widths: [18, 34, 12, 18, 18, 55, 10], formats: ['text', 'text', 'integer', 'money', 'date', 'text'], notes: ['Import amounts in rupees.'] }]);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  const actual = await readWorkbook(bytes, 'inventory.xlsx');
  assert.deepEqual(actual[0].rows.slice(1), rows);
  const zip = await JSZip.loadAsync(bytes);
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheet, /state="frozen"/);
  assert.match(sheet, /autoFilter ref="A1:G3"/);
  assert.doesNotMatch(sheet, /<f[ >]/);
  assert.match(sheet, /t="inlineStr"/);
  assert.match(await zip.file('xl/styles.xml').async('string'), /₹/);
});

test('CSV handles UTF-8 BOM, quoted commas, escaped quotes, embedded newline and leading-zero IDs', async () => {
  const input = '\uFEFFSKU,Product,Amount\r\n0012,"Cone, large",40\r\n0077,"A ""special""\nbox",50\r\n';
  assert.deepEqual(readCsv(input), [['SKU', 'Product', 'Amount'], ['0012', 'Cone, large', '40'], ['0077', 'A "special"\nbox', '50']]);
  assert.equal((await readWorkbook(Buffer.from(input), 'prices.CSV'))[0].rows[1][0], '0012');
  assert.throws(() => readCsv('A\n"unclosed'), /not closed/);
  assert.throws(() => readCsv('A\n"closed"extra'), /unexpected text/);
  assert.throws(() => readCsv('A\nabc"def'), /whole field/);
  await assert.rejects(readWorkbook(Buffer.from([0xff, 0xfe, 65, 0]), 'bad.csv'), /UTF-8/);
});

test('reads external shared strings, rich text, sparse cells, 1900 dates and zero-padding identifier formats', async () => {
  const bytes = await externalWorkbook({
    rows: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>46275</v></c><c r="C2" s="2"><v>123</v></c></row>',
    shared: `<sst xmlns="${NS}"><si><t>SKU</t></si><si><r><t>Price</t></r><r><t xml:space="preserve"> code</t></r></si><si><t>00042</t><rPh sb="0" eb="5"><t>ignored phonetics</t></rPh></si></sst>`,
    styles: `<styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="000000"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
  });
  const [sheet] = await readWorkbook(bytes, 'external.xlsx');
  assert.deepEqual(sheet.rows[0], ['SKU', '', 'Price code']);
  assert.deepEqual(sheet.rows[1], ['00042', '2026-09-10', '000123']);
});

test('supports the 1904 date system and fractional serials while rejecting Excel phantom date', async () => {
  const styles = `<styleSheet xmlns="${NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
  const bytes = await externalWorkbook({ date1904: true, styles, cells: '<c r="A1" s="1"><v>0</v></c><c r="B1" s="1"><v>0.5</v></c>' });
  assert.deepEqual((await readWorkbook(bytes, 'dates.xlsx'))[0].rows[0], ['1904-01-01', '1904-01-01T12:00:00.000Z']);
  await assert.rejects(readWorkbook(await externalWorkbook({ styles, cells: '<c r="A1" s="1"><v>60</v></c>' }), 'phantom.xlsx'), /29-Feb-1900/);
});

test('inherits date and identifier styles from Excel column and row formats', async () => {
  const bytes = await externalWorkbook({
    styles: `<styleSheet xmlns="${NS}"><numFmts><numFmt numFmtId="164" formatCode="000000"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    extra: { 'xl/worksheets/data.xml': `<worksheet xmlns="${NS}"><cols><col min="1" max="1" style="1"/></cols><sheetData><row r="1"><c r="A1"><v>46275</v></c></row><row r="2" s="2" customFormat="1"><c r="A2"><v>123</v></c></row></sheetData></worksheet>` },
  });
  assert.deepEqual((await readWorkbook(bytes, 'inherited.xlsx'))[0].rows, [['2026-09-10'], ['000123']]);
});

test('formula cells, cached formula results, error values, DTD and external workbook relationships are rejected', async () => {
  const formula = await externalWorkbook({ cells: '<c r="A1"><f>1+1</f><v>2</v></c>' });
  await assert.rejects(readWorkbook(formula, 'formula.xlsx'), /Paste Special.*Values/);
  const error = await externalWorkbook({ cells: '<c r="A1" t="e"><v>#VALUE!</v></c>' });
  await assert.rejects(readWorkbook(error, 'error.xlsx'), /Excel error #VALUE!/);
  const dtd = await externalWorkbook({ extra: { 'xl/sharedStrings.xml': '<!DOCTYPE sst [<!ENTITY a "example">]><sst/>' }, shared: '<sst/>' });
  await assert.rejects(readWorkbook(dtd, 'dtd.xlsx'), /DTD and entity/);
  const external = await externalWorkbook({ extra: { 'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" TargetMode="External" Target="https://example.invalid/data.xml"/></Relationships>` } });
  await assert.rejects(readWorkbook(external, 'linked.xlsx'), /External-linked/);
});

test('rejects macros, encrypted/legacy formats and malformed XML or ZIP input', async () => {
  await assert.rejects(readWorkbook(Buffer.from('anything'), 'legacy.xls'), /Legacy .xls/);
  await assert.rejects(readWorkbook(Buffer.from('anything'), 'macro.xlsm'), /Macro-enabled/);
  await assert.rejects(readWorkbook(Buffer.from('d0cf11e0a1b11ae1', 'hex'), 'encrypted.xlsx'), /Encrypted or legacy/);
  await assert.rejects(readWorkbook(Buffer.from('not zip'), 'bad.xlsx'), /valid XLSX/);
  await assert.rejects(readWorkbook(await externalWorkbook({ extra: { 'xl/vbaProject.bin': 'macro' } }), 'renamed.xlsx'), /Macro-enabled/);
  await assert.rejects(readWorkbook(await externalWorkbook({ cells: '<c r="A1"><v>1</c>' }), 'broken.xlsx'), /malformed XML/);
  await assert.rejects(readWorkbook(await externalWorkbook({ cells: '<c r="A1"><v>9007199254740992</v></c>' }), 'big-id.xlsx'), /supported precision/);
});

test('bounds import sizes, ZIP expansion and paths, sheet rows and columns', async () => {
  await assert.rejects(readWorkbook(Buffer.alloc(LIMITS.inputBytes + 1), 'huge.xlsx'), /5 MB/);
  await assert.rejects(readWorkbook(await externalWorkbook({ extra: { '../unsafe.xml': 'unsafe' } }), 'path.xlsx'), /Unsafe workbook ZIP path/);
  const hugeXml = ' '.repeat(LIMITS.xmlBytes + 1);
  await assert.rejects(readWorkbook(await externalWorkbook({ extra: { 'xl/extra.xml': hugeXml } }), 'expanded.xlsx'), /10 MB/);
  const many = {};
  for (let i = 0; i < 201; i++) many[`extras/${i}`] = '';
  await assert.rejects(readWorkbook(await externalWorkbook({ extra: many }), 'entries.xlsx'), /too many ZIP entries/);
  await assert.rejects(readWorkbook(await externalWorkbook({ rows: '<row r="5002"><c r="A5002"><v>1</v></c></row>' }), 'rows.xlsx'), /5000 data rows/);
  await assert.rejects(readWorkbook(await externalWorkbook({ cells: '<c r="BM1"><v>1</v></c>' }), 'cols.xlsx'), /64 columns/);
  assert.throws(() => readCsv(Array.from({ length: 5002 }, () => 'value').join('\n')), /5000 data rows/);
  assert.throws(() => readCsv(Array.from({ length: 65 }, () => 'column').join(',')), /64 columns/);
});

test('detects damaged workbook CRC and central-directory expanded-size claims before import', async () => {
  const corrupted = Buffer.from(await externalWorkbook());
  for (let offset = 0; offset < corrupted.length - 46; offset++) {
    if (corrupted.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = corrupted.readUInt16LE(offset + 28);
    const name = corrupted.subarray(offset + 46, offset + 46 + nameLength).toString();
    if (name === 'xl/worksheets/data.xml') { corrupted.writeUInt32LE(12345, offset + 16); break; }
  }
  await assert.rejects(readWorkbook(corrupted, 'damaged.xlsx'), /checksum mismatch/);
  const expansion = Buffer.from(await externalWorkbook());
  for (let offset = 0; offset < expansion.length - 46; offset++) {
    if (expansion.readUInt32LE(offset) !== 0x02014b50) continue;
    expansion.writeUInt32LE(LIMITS.uncompressedBytes + 1, offset + 24);
    break;
  }
  await assert.rejects(readWorkbook(expansion, 'expanded.xlsx'), /30 MB/);
});

test('duplicate cell addresses, invalid number fields, missing shared strings and invalid export inputs fail explicitly', async () => {
  await assert.rejects(readWorkbook(await externalWorkbook({ cells: '<c r="A1"><v>1</v></c><c r="A1"><v>2</v></c>' }), 'duplicate.xlsx'), /duplicate cell/);
  await assert.rejects(readWorkbook(await externalWorkbook({ cells: '<c r="A1"><v>hello</v></c>' }), 'number.xlsx'), /numeric cell/);
  await assert.rejects(readWorkbook(await externalWorkbook({ cells: '<c r="A1" t="s"><v>9</v></c>' }), 'missing.xlsx'), /shared string reference/);
  await assert.rejects(writeWorkbook([{ name: 'Bad/name', headers: ['A'], rows: [] }]), /sheet names/);
  await assert.rejects(writeWorkbook([{ name: 'Good', headers: ['A'], rows: [[NaN]] }]), /supported precision/);
  await assert.rejects(writeWorkbook([{ name: 'Good', headers: ['A'], rows: [['2026-02-31']], formats: ['date'] }]), /invalid date/);
  await assert.rejects(writeWorkbook([{ name: 'Good', headers: ['A'], rows: [[1, 2]] }]), /do not match/);
});

test('multi-sheet report round trip keeps independent headers and empty sheets', async () => {
  const input = [{ name: 'Stock value', headers: ['SKU', 'Cost'], rows: [['0001', 20]], formats: ['text', 'money'] }, { name: 'Receivables', headers: ['Customer', 'Balance'], rows: [] }];
  const actual = await readWorkbook(await writeWorkbook(input), 'report.xlsx');
  assert.deepEqual(actual, [{ name: 'Stock value', rows: [['SKU', 'Cost'], ['0001', 20]] }, { name: 'Receivables', rows: [['Customer', 'Balance']] }]);
});

test('headers-only templates and wide guide sheets work; boundary failures carry a user-facing HTTP code', async () => {
  const bytes = await writeWorkbook([{ name: 'Products', headers: ['SKU', 'Price'], rows: [], formats: ['text', 'money'] }, { name: 'Guide', headers: ['How to use'], rows: [['Fill Products and preview first.']], widths: [115] }]);
  assert.deepEqual((await readWorkbook(bytes, 'template.xlsx'))[0].rows, [['SKU', 'Price']]);
  for (const filename of [undefined, null, 123, {}, '']) {
    await assert.rejects(readWorkbook(bytes, filename), error => error.code === 'EXCEL_ERROR' && error.status === 400 && /named/.test(error.message));
  }
  await assert.rejects(readWorkbook(Buffer.from('invalid'), 'broken.xlsx'), error => error.code === 'EXCEL_ERROR' && error.status === 400);
  await assert.rejects(writeWorkbook([null]), error => error.code === 'EXCEL_ERROR' && error.status === 400);
  await assert.rejects(writeWorkbook([{ name: 'Dates', headers: ['Date'], rows: [[new Date(NaN)]] }]), error => error.code === 'EXCEL_ERROR');
  await assert.rejects(writeWorkbook([{ name: 'Sparse', headers: Array(2), rows: [] }]), error => error.code === 'EXCEL_ERROR');
});

test('deterministic malformed-container mutations cannot escape format-error handling', async () => {
  const original = await externalWorkbook();
  let seed = 918273;
  let rejected = 0;
  for (let sample = 0; sample < 60; sample++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const changed = Buffer.from(original);
    const position = seed % changed.length;
    changed[position] ^= 1 + ((seed >>> 16) % 255);
    try { await readWorkbook(changed, 'mutated.xlsx'); }
    catch (error) {
      rejected++;
      assert.equal(error.code, 'EXCEL_ERROR', `Mutation ${sample}: ${error.stack}`);
      assert.equal(error.status, 400);
    }
  }
  assert.ok(rejected >= 40, `${rejected} mutations were rejected`);
});
