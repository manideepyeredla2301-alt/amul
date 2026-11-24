// Converts the first worksheet to the CSV format used by the existing reviewed import.
// read-excel-file 9.3.20 is bundled locally in /admin/vendor (MIT license alongside it).
(() => {
  const MAX_BYTES = 1_000_000;
  const MAX_PRODUCTS = 200;
  const MAX_COLUMNS = 40;
  const MAX_CELL_LENGTH = 1_000;

  function cellText(value) {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
    if (text.length > MAX_CELL_LENGTH) throw new Error('An Excel cell is too long to import.');
    return text;
  }

  function csvCell(value) {
    return `"${cellText(value).replaceAll('"', '""')}"`;
  }

  async function toCsvFile(file) {
    if (!(file instanceof File) || !/\.xlsx$/i.test(file.name)) throw new Error('Choose an .xlsx Excel file.');
    if (file.size > MAX_BYTES) throw new Error('Excel file must be under 1 MB.');
    if (typeof globalThis.readXlsxFile !== 'function') throw new Error('Excel reader is unavailable. Reload this page and try again.');

    let sheets;
    try { sheets = await globalThis.readXlsxFile(file); }
    catch { throw new Error('Could not read this Excel file. Save it as .xlsx and try again.'); }
    const data = sheets?.[0]?.data;
    if (!Array.isArray(data)) throw new Error('The first Excel worksheet is empty.');
    const rows = data.filter(row => Array.isArray(row) && row.some(value => cellText(value).trim() !== ''));
    if (rows.length < 2) throw new Error('The first Excel worksheet needs a header and at least one product.');
    if (rows.length - 1 > MAX_PRODUCTS) throw new Error('Excel file must contain 1–200 products.');

    const header = rows[0].map(cellText);
    while (header.length && !header.at(-1).trim()) header.pop();
    if (!header.length || header.length > MAX_COLUMNS || header.some(value => !value.trim()))
      throw new Error('The first Excel row needs 1–40 named columns.');
    if (new Set(header.map(value => value.trim())).size !== header.length)
      throw new Error('The Excel header contains duplicate columns.');

    const normalized = [header];
    for (const [index, row] of rows.slice(1).entries()) {
      if (row.slice(header.length).some(value => cellText(value).trim() !== ''))
        throw new Error(`Excel row ${index + 2} has a value without a column heading.`);
      normalized.push(Array.from({ length: header.length }, (_, column) => cellText(row[column])));
    }
    const csv = '\ufeff' + normalized.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    if (new TextEncoder().encode(csv).length > MAX_BYTES) throw new Error('Converted Excel data exceeds the 1 MB import limit.');
    return new File([csv], file.name.replace(/\.xlsx$/i, '.csv'), { type: 'text/csv' });
  }

  globalThis.CafeExcelImport = { toCsvFile };
})();
