# Run FrostFlow on Windows

1. Extract the complete ZIP to a writable local folder, for example
   `C:\Business\FrostFlow`. Do not run the application from inside the ZIP.
2. Double-click `FrostFlow-Desktop.bat`.
3. FrostFlow opens in a desktop-style Windows app window. The local engine runs
   silently in the background on this PC; you do not need to open a localhost
   browser tab.
4. For troubleshooting only, `start-frostflow.bat` still starts the same engine
   in a visible terminal.

Core stock, invoices, purchases, payments, reports and Excel imports work offline.
The local engine address is on this PC only; it is not a public website. Internet
is needed only for external services configured separately.

## Runtime

The full portable package includes `runtime\node.exe`; no Node installation or
`npm install` is needed. The launcher prefers that packaged runtime.

If your copy does not include the runtime, install Node.js **24 LTS or newer** on
Windows so `node.exe` is available on PATH. Close and reopen the launcher after
installation. The launcher displays a useful error if Node is absent or too old.

Folder names containing spaces are supported. Use a local folder you can write
to. Avoid `Program Files`, a shared network folder or an actively synchronized
cloud folder for the live database.

## Business data and updates

The live database is `data\frostflow.sqlite` inside the extracted application
folder. SQLite may also create `frostflow.sqlite-wal` and
`frostflow.sqlite-shm` alongside it while FrostFlow is running.

Use the application's backup action regularly and copy the resulting backup
to another drive. Before updating:

1. Create a backup and stop FrostFlow with Ctrl+C.
2. Keep a copy of the entire existing `data` folder.
3. Extract the new application into a separate folder. Keep the old application
   and data until the update has been checked.
4. With both copies stopped, copy the existing `data` folder into the new
   application folder. Start the new copy and check stock and ledger totals.

Do not replace your live database with a trial database or an empty database from
another extraction. Do not copy only `frostflow.sqlite` while the service is
running; use the application backup action or stop the service first.

If you deliberately set the `FROSTFLOW_DB` environment variable, the service uses
that database path instead. The launcher prints the selected path on startup.

## Trial before entering live records

Use a separate extracted folder for a trial. Add clearly labelled trial products,
customers and suppliers there; receive trial stock, post one wholesale invoice
and one retail sale, record a payment, and inspect the customer balance and stock
value. Download an Excel template, fill a small example, review its import preview,
then commit it and check the result.

Run only one trial or live copy at a time. Stop the trial before starting the live
folder. Begin live work in a separate empty database or your retained live data;
do not mix trial transactions into business records.

## If it does not open

- If FrostFlow 0.2 is already running, the desktop launcher opens that existing service.
  To switch folders, stop the earlier FrostFlow terminal first.
- If another application occupies port 4317, or an older FrostFlow version is
  running, the launcher reports it and leaves existing processes alone.
- If the app window does not open, manually open `http://127.0.0.1:4317` only as
  a troubleshooting fallback.
- If startup fails, read the error left in the terminal. Confirm the ZIP was
  fully extracted, the runtime is present, and the folder is writable.

For manual startup, open a terminal in the application folder and run
`runtime\node.exe server.js`, or `node server.js` when using an installed runtime.
