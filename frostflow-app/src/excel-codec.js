'use strict';

// Offline OOXML/CSV boundary. Business rules and import transactions belong to
// the application service, not to this format codec. No Office automation needed.
const JSZip = require('../vendor/jszip.min.js');
const sax = require('../vendor/sax.js');
const path = require('node:path').posix;
const { crc32 } = require('node:zlib');

const LIMITS = Object.freeze({ inputBytes: 5 * 1024 * 1024, uncompressedBytes: 30 * 1024 * 1024, xmlBytes: 10 * 1024 * 1024, entries: 200, dataRows: 5000, columns: 64, cellCharacters: 32767 });
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function fail(message) {
  const error = new Error(message);
  error.code = 'EXCEL_ERROR';
  error.status = 400;
  throw error;
}
function baseName(name) { return name.includes(':') ? name.slice(name.indexOf(':') + 1) : name; }
function attr(node, name) {
  for (const [key, value] of Object.entries(node.attributes)) if (baseName(key) === name) return value;
  return undefined;
}
function integer(value, label, minimum = 0) {
  if (!/^\d+$/.test(String(value))) fail(`Invalid ${label}.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < minimum) fail(`Invalid ${label}.`);
  return n;
}
function xml(value) {
  const text = String(value ?? '');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(text)) fail('A cell contains an unsupported control character.');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function columnName(n) {
  let name = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
function cellAddress(address) {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(address || '');
  if (!match) fail(`Invalid Excel cell address: ${address}.`);
  let col = 0;
  for (const character of match[1].toUpperCase()) col = col * 26 + character.charCodeAt(0) - 64;
  return { col: col - 1, row: integer(match[2], 'cell row', 1) - 1 };
}
function textValue(value) {
  if (value.length > LIMITS.cellCharacters) fail('A cell exceeds the Excel limit of 32,767 characters.');
  // OOXML escapes literal strings beginning with _xHHHH_ using _x005F_.
  const decoded = value.replace(/_x([0-9a-f]{4})_/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(decoded)) fail('A cell contains an unsupported control character.');
  return decoded;
}
function stringXml(value) {
  const text = String(value ?? '');
  if (text.length > LIMITS.cellCharacters) fail('A cell exceeds the Excel limit of 32,767 characters.');
  return xml(text.replace(/_x[0-9a-f]{4}_/gi, match => `_x005F_${match.slice(1)}`));
}

function parseXml(source, label, callbacks) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) fail(`${label}: DTD and entity declarations are not allowed.`);
  const parser = sax.parser(true, { trim: false, normalize: false, lowercase: false, strictEntities: true });
  let depth = 0;
  parser.onopentag = node => {
    if (++depth > 64) fail(`${label}: XML nesting is too deep.`);
    callbacks.open?.(baseName(node.name), node);
  };
  parser.onclosetag = name => { callbacks.close?.(baseName(name)); depth -= 1; };
  parser.ontext = value => callbacks.text?.(value);
  parser.oncdata = value => callbacks.text?.(value);
  parser.onerror = error => fail(`${label}: malformed XML (${error.message.split('\n')[0]}).`);
  parser.write(source).close();
}

// Inspect the central directory before asking JSZip to inflate anything. Do not
// rely on JSZip's path sanitization or private implementation properties.
function inspectZip(buffer) {
  if (buffer.length < 22) fail('This is not a valid XLSX workbook.');
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0) fail('This is not a valid XLSX ZIP container. Password-protected workbooks are unsupported.');
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count) fail('Multi-volume ZIP workbooks are unsupported.');
  if (count === 65535 || directorySize === 0xffffffff || directoryOffset === 0xffffffff) fail('ZIP64 workbooks are unsupported.');
  if (count > LIMITS.entries) fail(`Workbook contains too many ZIP entries (maximum ${LIMITS.entries}).`);
  if (directoryOffset + directorySize !== end) fail('Invalid workbook ZIP directory.');
  let offset = directoryOffset;
  let total = 0;
  const files = new Map();
  const ranges = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) fail('Invalid workbook ZIP entry.');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (flags & 1 || flags & 64) fail('Password-protected or encrypted Excel files are unsupported. Save an unprotected .xlsx copy.');
    if (![0, 8].includes(method)) fail('Unsupported workbook ZIP compression.');
    if ([size, compressedSize, localOffset].includes(0xffffffff)) fail('ZIP64 workbooks are unsupported.');
    if (offset + 46 + nameLength + extraLength + commentLength > end) fail('Truncated workbook ZIP entry.');
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => part === '..' || part === '.')) fail('Unsafe workbook ZIP path.');
    if (files.has(name)) fail('Workbook contains duplicate ZIP entries.');
    if (/vbaProject|macrosheet|vbaData/i.test(name)) fail('Macro-enabled workbooks are unsupported. Save as a plain .xlsx file.');
    total += size;
    if (total > LIMITS.uncompressedBytes) fail('Workbook expands beyond the 30 MB safety limit.');
    if (/\.(xml|rels)$/i.test(name) && size > LIMITS.xmlBytes) fail('An XML part exceeds the 10 MB workbook limit.');
    if (localOffset + 30 > directoryOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) fail('Invalid workbook ZIP local header.');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > directoryOffset || !buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes) || buffer.readUInt16LE(localOffset + 8) !== method || buffer.readUInt16LE(localOffset + 6) !== flags) fail('Workbook ZIP headers do not match.');
    ranges.push([localOffset, dataStart + compressedSize]);
    files.set(name, { size, crc });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== directoryOffset + directorySize) fail('Invalid workbook ZIP directory length.');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) fail('Workbook ZIP entries overlap.');
  return files;
}

function relationshipPath(base, target) {
  if (!target || /[\\\0?#]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) fail('Invalid workbook relationship target.');
  const joined = target.startsWith('/') ? target.slice(1) : path.join(path.dirname(base), target);
  const normalized = path.normalize(joined);
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) fail('Unsafe workbook relationship target.');
  return normalized;
}
function parseRelationships(source, base) {
  const relationships = new Map();
  parseXml(source, 'Workbook relationships', { open(name, node) {
    if (name !== 'Relationship') return;
    const id = attr(node, 'Id');
    const type = attr(node, 'Type') || '';
    if (!id || relationships.has(id)) fail('Invalid or duplicate workbook relationship ID.');
    if (attr(node, 'TargetMode') === 'External' || /externalLink|vba|macro/i.test(type)) fail('External-linked or macro-enabled workbooks are unsupported. Save a plain .xlsx copy with values.');
    relationships.set(id, { type, target: relationshipPath(base, attr(node, 'Target')) });
  } });
  return relationships;
}
function readSharedStrings(source) {
  const strings = [];
  let inside = false;
  let inText = false;
  let phonetic = 0;
  let value = '';
  parseXml(source, 'Shared strings', {
    open(name) {
      if (name === 'si') { inside = true; value = ''; }
      if (name === 'rPh') phonetic += 1;
      if (name === 't' && inside && !phonetic) inText = true;
    },
    text(text) { if (inText) value += text; },
    close(name) {
      if (name === 't') inText = false;
      if (name === 'rPh') phonetic -= 1;
      if (name === 'si') { strings.push(textValue(value)); inside = false; }
    },
  });
  return strings;
}
function readStyles(source) {
  const custom = new Map();
  const formats = [];
  let inCellXfs = false;
  parseXml(source, 'Cell styles', {
    open(name, node) {
      if (name === 'numFmt') custom.set(integer(attr(node, 'numFmtId'), 'number format'), attr(node, 'formatCode') || '');
      if (name === 'cellXfs') inCellXfs = true;
      if (name === 'xf' && inCellXfs) formats.push(integer(attr(node, 'numFmtId') ?? '0', 'style format'));
    }, close(name) { if (name === 'cellXfs') inCellXfs = false; },
  });
  return formats.map(id => {
    const code = custom.get(id) || '';
    const tokens = code.replace(/"[^"]*"|\\.|_.|\*./g, '').replace(/\[[^\]]*\]/g, '');
    const date = (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58) || /[ymdhis]/i.test(tokens);
    return { date, zeroPadding: /^0{2,}$/.test(code) ? code.length : 0 };
  });
}
function excelDate(serial, date1904) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) fail('Invalid Excel date serial.');
  if (!date1904 && Math.floor(serial) === 60) fail('Excel contains the invalid date 29-Feb-1900. Enter a valid date.');
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const adjusted = serial - (!date1904 && serial >= 61 ? 1 : 0);
  const date = new Date(base + Math.round(adjusted * 86400000));
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() > 9999) fail('Invalid Excel date.');
  const iso = date.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso;
}
function readSheet(source, name, shared, styles, date1904) {
  const rows = [];
  let currentRow = -1;
  let nextCol = 0;
  let cell = null;
  let collecting = '';
  let inSheetData = false;
  let seenData = false;
  let maxCol = 0;
  const seenRows = new Set();
  const seenCells = new Set();
  let phonetic = 0;
  const columnStyles = [];
  let rowStyle;
  parseXml(source, `Sheet ${name}`, {
    open(tag, node) {
      if (tag === 'col' && attr(node, 'style') !== undefined) {
        const min = integer(attr(node, 'min'), 'column range', 1);
        const max = integer(attr(node, 'max'), 'column range', 1);
        if (max < min) fail(`${name}: invalid column style range.`);
        const style = attr(node, 'style');
        for (let col = min - 1; col < Math.min(max, LIMITS.columns); col++) columnStyles[col] = style;
      }
      if (tag === 'sheetData') { inSheetData = true; seenData = true; }
      if (!inSheetData) return;
      if (tag === 'row') {
        currentRow = attr(node, 'r') ? integer(attr(node, 'r'), 'sheet row', 1) - 1 : currentRow + 1;
        if (currentRow > LIMITS.dataRows) fail(`${name}: import at most ${LIMITS.dataRows} data rows plus one header row.`);
        if (seenRows.has(currentRow)) fail(`${name}: duplicate row number.`);
        seenRows.add(currentRow); nextCol = 0;
        rowStyle = attr(node, 'customFormat') === '0' ? undefined : attr(node, 's');
      }
      if (tag === 'c') {
        if (currentRow < 0 || cell) fail(`${name}: invalid cell placement.`);
        const position = attr(node, 'r') ? cellAddress(attr(node, 'r')) : { row: currentRow, col: nextCol };
        if (position.row !== currentRow) fail(`${name}: cell address does not match its row.`);
        if (position.col >= LIMITS.columns) fail(`${name}: import at most ${LIMITS.columns} columns.`);
        const key = `${position.row}:${position.col}`;
        if (seenCells.has(key)) fail(`${name}: duplicate cell address.`);
        seenCells.add(key);
        nextCol = position.col + 1;
        cell = { ...position, type: attr(node, 't') || 'n', style: attr(node, 's') ?? rowStyle ?? columnStyles[position.col], value: '', inline: '' };
      }
      if (tag === 'f') fail(`${name}: formula cells are not accepted. In Excel, copy the data and use Paste Special → Values, then save and import again.`);
      if (tag === 'rPh') phonetic += 1;
      if (cell && tag === 'v') collecting = 'value';
      if (cell && tag === 't' && !phonetic) collecting = 'inline';
    },
    text(text) { if (cell && collecting) cell[collecting] += text; },
    close(tag) {
      if (tag === 'sheetData') inSheetData = false;
      if (tag === 'rPh') phonetic -= 1;
      if (tag === 'v' || tag === 't') collecting = '';
      if (tag !== 'c' || !cell) return;
      let value = '';
      if (cell.type === 'inlineStr') value = textValue(cell.inline);
      else if (cell.type === 's') {
        const index = integer(cell.value.trim(), 'shared string index');
        if (index >= shared.length) fail(`${name}: shared string reference is missing.`);
        value = shared[index];
      } else if (cell.type === 'str') value = textValue(cell.value);
      else if (cell.type === 'e') fail(`${name}: cell ${columnName(cell.col)}${cell.row + 1} contains Excel error ${cell.value}. Correct it before importing.`);
      else if (cell.type === 'b') {
        if (!['0', '1'].includes(cell.value.trim())) fail(`${name}: invalid Boolean cell.`);
        value = cell.value.trim() === '1';
      } else if (cell.type === 'd') {
        const raw = cell.value.trim();
        if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(raw) || Number.isNaN(Date.parse(raw))) fail(`${name}: invalid ISO date cell.`);
        value = raw;
      } else if (cell.type === 'n') {
        const raw = cell.value.trim();
        if (raw) {
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) fail(`${name}: invalid numeric cell.`);
          value = Number(raw);
          if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail(`${name}: numeric cell is outside the supported precision. Store long identifiers as text in Excel.`);
          let style;
          if (cell.style !== undefined) {
            const styleId = integer(cell.style, 'cell style');
            if (styleId >= styles.length && styleId !== 0) fail(`${name}: missing cell style.`);
            style = styles[styleId];
          }
          if (style?.date) value = excelDate(value, date1904);
          else if (style?.zeroPadding && Number.isInteger(value) && value >= 0) value = String(value).padStart(style.zeroPadding, '0');
        }
      } else fail(`${name}: unsupported Excel cell type ${cell.type}.`);
      rows[cell.row] ||= [];
      rows[cell.row][cell.col] = value;
      maxCol = Math.max(maxCol, cell.col + 1);
      cell = null;
    },
  });
  if (!seenData) fail(`${name}: worksheet data is missing.`);
  while (rows.length && (!rows.at(-1) || rows.at(-1).every(value => value === '' || value === undefined))) rows.pop();
  return { name, rows: Array.from({ length: rows.length }, (_, i) => Array.from({ length: maxCol }, (_, j) => rows[i]?.[j] ?? '')) };
}

function readCsv(text) {
  if (typeof text !== 'string') fail('CSV input must be text.');
  if (Buffer.byteLength(text, 'utf8') > LIMITS.inputBytes) fail('Import file exceeds the 5 MB limit.');
  text = text.replace(/^\uFEFF/, '');
  if (text.includes('\0')) fail('CSV contains null bytes. Save the CSV using UTF-8 encoding.');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closed = false;
  const pushField = () => {
    if (field.length > LIMITS.cellCharacters) fail('A CSV cell exceeds 32,767 characters.');
    row.push(field); field = ''; closed = false;
    if (row.length > LIMITS.columns) fail(`CSV may contain at most ${LIMITS.columns} columns.`);
  };
  const pushRow = () => {
    pushField(); rows.push(row); row = [];
    if (rows.length > LIMITS.dataRows + 1) fail(`CSV may contain at most ${LIMITS.dataRows} data rows plus a header.`);
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === ',') pushField();
    else if (char === '\r' || char === '\n') { if (char === '\r' && text[i + 1] === '\n') i++; pushRow(); }
    else if (closed) fail('Malformed CSV: unexpected text after a closing quote.');
    else if (char === '"') { if (field) fail('Malformed CSV: quotes must enclose the whole field.'); quoted = true; }
    else field += char;
    if (field.length > LIMITS.cellCharacters) fail('A CSV cell exceeds 32,767 characters.');
  }
  if (quoted) fail('Malformed CSV: an enclosing quote was not closed.');
  if (row.length || field || closed) pushRow();
  while (rows.length && rows.at(-1).every(value => value === '')) rows.pop();
  return rows;
}

async function readWorkbook(input, filename) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) fail('Workbook input must be a byte buffer.');
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 255) fail('Choose a named .xlsx workbook or UTF-8 .csv file.');
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length > LIMITS.inputBytes) fail('Import file exceeds the 5 MB limit.');
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.csv') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { fail('CSV must use UTF-8 encoding. Choose CSV UTF-8 when saving in Excel.'); }
    return [{ name: path.basename(filename, ext) || 'Import', rows: readCsv(text) }];
  }
  if (ext === '.xls') fail('Legacy .xls files are unsupported. Open in Excel and save as .xlsx or CSV UTF-8.');
  if (['.xlsm', '.xlsb', '.xlam'].includes(ext)) fail('Macro-enabled/binary Excel workbooks are unsupported. Save a plain .xlsx copy.');
  if (ext !== '.xlsx') fail('Choose an .xlsx workbook or UTF-8 .csv file.');
  if (buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) fail('Encrypted or legacy Excel file detected. Save an unprotected .xlsx copy.');
  const entries = inspectZip(buffer);
  let zip;
  try { zip = await JSZip.loadAsync(buffer, { createFolders: false }); }
  catch (error) { fail(`Cannot read XLSX container: ${error.message}`); }
  let expandedBytes = 0;
  const cache = new Map();
  async function readPart(name, optional = false) {
    if (cache.has(name)) return cache.get(name);
    if (!entries.has(name) || !zip.file(name)) {
      if (optional) return undefined;
      fail(`Workbook part is missing: ${name}.`);
    }
    const file = zip.file(name);
    if (file.unsafeOriginalName && file.unsafeOriginalName !== name) fail('Unsafe workbook ZIP filename.');
    const stream = file.nodeStream('nodebuffer');
    const chunks = [];
    let length = 0;
    let actualCrc = 0;
    try {
      for await (const chunk of stream) {
        length += chunk.length; expandedBytes += chunk.length;
        if (length > LIMITS.xmlBytes || expandedBytes > LIMITS.uncompressedBytes) { stream.destroy(); fail('Workbook expansion exceeds the import safety limits.'); }
        actualCrc = crc32(chunk, actualCrc);
        chunks.push(chunk);
      }
    } catch (error) { fail(`Cannot decode workbook part ${name}: ${error.message}`); }
    if (length !== entries.get(name).size) fail('Workbook part size does not match its ZIP directory.');
    if (actualCrc !== entries.get(name).crc) fail('Workbook checksum mismatch. The file may be damaged; save a fresh copy in Excel.');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/^\uFEFF/, ''); }
    catch { fail('Workbook XML must use UTF-8 encoding. Save a fresh .xlsx copy in Excel.'); }
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(content)) fail(`${name}: DTD and entity declarations are not allowed.`);
    cache.set(name, content);
    return content;
  }
  const types = await readPart('[Content_Types].xml');
  if (/macroEnabled|vbaProject|macrosheet/i.test(types)) fail('Macro-enabled workbooks are unsupported. Save a plain .xlsx copy.');
  parseXml(types, 'Content types', {});
  const rootRels = await readPart('_rels/.rels', true);
  let workbookPath = 'xl/workbook.xml';
  if (rootRels) {
    const roots = parseRelationships(rootRels, '_root');
    const office = [...roots.values()].find(rel => /\/officeDocument$/.test(rel.type));
    if (!office) fail('The file is not an Excel workbook.');
    workbookPath = office.target;
  }
  const workbook = await readPart(workbookPath);
  const relsPath = path.join(path.dirname(workbookPath), '_rels', `${path.basename(workbookPath)}.rels`);
  const relationships = parseRelationships(await readPart(relsPath), workbookPath);
  const sheets = [];
  let date1904 = false;
  parseXml(workbook, 'Workbook', { open(name, node) {
    if (name === 'workbookPr') date1904 = ['1', 'true'].includes(attr(node, 'date1904'));
    if (name === 'sheet') {
      const title = attr(node, 'name');
      const rel = relationships.get(attr(node, 'id'));
      if (!title || !rel || !/\/worksheet$/.test(rel.type)) fail('Workbook contains an invalid or unsupported sheet.');
      if (sheets.some(sheet => sheet.name.toLowerCase() === title.toLowerCase())) fail('Workbook has duplicate sheet names.');
      sheets.push({ name: title, target: rel.target });
    }
  } });
  if (!sheets.length) fail('Workbook has no worksheets.');
  const values = [...relationships.values()];
  const sharedRel = values.find(rel => /\/sharedStrings$/.test(rel.type));
  const stylesRel = values.find(rel => /\/styles$/.test(rel.type));
  const shared = sharedRel ? readSharedStrings(await readPart(sharedRel.target)) : [];
  const styles = stylesRel ? readStyles(await readPart(stylesRel.target)) : [];
  const result = [];
  for (const sheet of sheets) result.push(readSheet(await readPart(sheet.target), sheet.name, shared, styles, date1904));
  return result;
}

const STYLES = `${XML_HEADER}<styleSheet xmlns="${NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;₹&quot; #,##0.00;[Red](&quot;₹&quot; #,##0.00)"/><numFmt numFmtId="165" formatCode="dd-mmm-yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17324D"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function dateSerial(value) {
  if (value instanceof Date && !Number.isFinite(value.getTime())) fail('Export contains an invalid date.');
  const iso = value instanceof Date ? value.toISOString() : String(value);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)?$/.test(iso)) fail('Export dates must be YYYY-MM-DD or UTC ISO date values.');
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== iso.slice(0, 10)) fail('Export contains an invalid date.');
  if (timestamp < Date.UTC(1900, 0, 1) || timestamp > Date.UTC(9999, 11, 31, 23, 59, 59, 999)) fail('Export date must be between 1900 and 9999.');
  return (timestamp - Date.UTC(1899, 11, 31)) / 86400000 + (timestamp >= Date.UTC(1900, 2, 1) ? 1 : 0);
}
function encodeCell(value, ref, format, header = false) {
  const style = header ? 1 : ({ money: 2, integer: 3, date: 4, text: 5 }[format] || 0);
  if (value === null || value === undefined || value === '') return `<c r="${ref}" s="${style}"/>`;
  if (header || format === 'text' || (typeof value === 'string' && format !== 'date')) return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${stringXml(value)}</t></is></c>`;
  if (format === 'date' || value instanceof Date) return `<c r="${ref}" s="4"><v>${dateSerial(value)}</v></c>`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('Export contains a number outside the supported precision.');
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') return `<c r="${ref}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  fail('Export cells must contain strings, numbers, booleans, dates or blanks.');
}

async function writeWorkbook(sheets) {
  if (!Array.isArray(sheets) || sheets.length < 1 || sheets.length > 30) fail('Export needs 1 to 30 worksheets.');
  const names = new Set();
  const zip = new JSZip();
  let workbookSheets = '';
  let workbookRels = '';
  let typeOverrides = '';
  for (let index = 0; index < sheets.length; index++) {
    if (!sheets[index] || typeof sheets[index] !== 'object') fail('Export worksheets must be objects with name, headers and rows.');
    const { name, headers, rows, widths = [], formats = [], notes = [] } = sheets[index];
    if (typeof name !== 'string' || !name.trim() || name.length > 31 || /[\\/*?:\[\]]/.test(name) || name.startsWith("'") || name.endsWith("'") || names.has(name.toLowerCase())) fail('Excel sheet names must be unique, 1–31 characters, and contain no \\ / * ? : [ ] characters.');
    names.add(name.toLowerCase());
    if (!Array.isArray(headers) || !headers.length || headers.length > LIMITS.columns || !Array.from(headers).every(header => typeof header === 'string')) fail('Export headers must be an array of 1–64 strings.');
    if (!Array.isArray(rows) || rows.length > LIMITS.dataRows) fail(`Export each sheet in batches of at most ${LIMITS.dataRows} rows.`);
    if (!Array.isArray(widths) || !Array.isArray(formats) || formats.some(format => format && !['money', 'integer', 'date', 'text'].includes(format))) fail('Invalid export column format.');
    if (!Array.isArray(notes) || notes.some(note => typeof note !== 'string')) fail('Export notes must be strings.');
    const number = index + 1;
    const endCol = columnName(headers.length - 1);
    const lastRow = rows.length + 1;
    const columns = headers.map((header, i) => {
      const width = widths[i] ?? Math.min(36, Math.max(14, header.length + 3));
      if (!Number.isFinite(width) || width < 4 || width > 150) fail('Export column widths must be between 4 and 150.');
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
    }).join('');
    const headerRow = `<row r="1" ht="34" customHeight="1">${headers.map((header, i) => encodeCell(header, `${columnName(i)}1`, 'text', true)).join('')}</row>`;
    const body = rows.map((row, i) => {
      if (!Array.isArray(row) || row.length > headers.length) fail(`Export sheet ${name}, row ${i + 2}: values do not match its headers.`);
      return `<row r="${i + 2}">${headers.map((_, j) => encodeCell(row[j], `${columnName(j)}${i + 2}`, formats[j])).join('')}</row>`;
    }).join('');
    // Optional notes are workbook metadata, keeping the tabular header and rows
    // clean for round-trip imports. User-facing instructions can use their own tab.
    const worksheet = `${XML_HEADER}<worksheet xmlns="${NS}" xmlns:r="${REL}"><dimension ref="A1:${endCol}${lastRow}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${columns}</cols><sheetData>${headerRow}${body}</sheetData><autoFilter ref="A1:${endCol}${lastRow}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
    if (Buffer.byteLength(worksheet) > LIMITS.xmlBytes) fail('Export sheet exceeds the 10 MB XML limit. Use a smaller date range.');
    zip.file(`xl/worksheets/sheet${number}.xml`, worksheet);
    workbookSheets += `<sheet name="${xml(name)}" sheetId="${number}" r:id="rId${number}"/>`;
    workbookRels += `<Relationship Id="rId${number}" Type="${REL}/worksheet" Target="worksheets/sheet${number}.xml"/>`;
    typeOverrides += `<Override PartName="/xl/worksheets/sheet${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  }
  zip.file('xl/workbook.xml', `${XML_HEADER}<workbook xmlns="${NS}" xmlns:r="${REL}"><workbookPr date1904="0"/><bookViews><workbookView/></bookViews><sheets>${workbookSheets}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `${XML_HEADER}<Relationships xmlns="${PKG_REL}">${workbookRels}<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', STYLES);
  zip.file('_rels/.rels', `${XML_HEADER}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  const noteText = sheets.filter(sheet => sheet.notes?.length).map(sheet => `${sheet.name}: ${sheet.notes.join('\n')}`).join('\n\n');
  zip.file('docProps/core.xml', `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>FrostFlow ERP</dc:creator><dc:description>${xml(noteText)}</dc:description></cp:coreProperties>`);
  zip.file('[Content_Types].xml', `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${typeOverrides}</Types>`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (buffer.length > LIMITS.inputBytes) fail('Export exceeds 5 MB. Use a smaller date range to keep it importable.');
  inspectZip(buffer);
  return buffer;
}

module.exports = { readWorkbook, writeWorkbook, readCsv, LIMITS };
