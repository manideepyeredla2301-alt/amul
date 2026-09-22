# Offline Excel dependencies

These redistributable dependencies are included so that the application can read
and write XLSX files without internet access, Excel installation, or `npm install`.

| File | Version | Source | License |
| --- | --- | --- | --- |
| jszip.min.js | 3.10.1 | https://github.com/Stuk/jszip | MIT (selected from dual MIT/GPL licensing), see JSZIP-LICENSE.markdown |
| sax.js | 1.6.1 | https://github.com/isaacs/sax-js | BlueOak-1.0.0, see SAX-LICENSE.md |

Application-specific XML, ZIP limits and cell validation live in
`src/excel-codec.js`. The codec does not execute formulas, macros or external links.
