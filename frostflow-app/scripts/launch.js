'use strict';

// Called by start-frostflow.bat using the packaged Node runtime when available.
// Keep the business service attached to this terminal so its shutdown is visible.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const APP_ROOT = path.resolve(__dirname, '..');
const APP_URL = 'http://127.0.0.1:4317';
const HEALTH_URL = `${APP_URL}/api/health`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function isFrostFlow(health) {
  return health?.ok === true && health.mode === 'offline-first' && /^0\.2\./.test(String(health.version)) && Number.isInteger(health.revision);
}

async function healthCheck() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1000), redirect: 'error' });
    if (!response.ok || !String(response.headers.get('content-type')).includes('application/json')) return { state: 'occupied' };
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 16384) return { state: 'occupied' };
    // A bounded read also handles servers which omit Content-Length.
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 16384) { await reader.cancel(); return { state: 'occupied' }; }
      parts.push(Buffer.from(chunk.value));
    }
    const health = JSON.parse(Buffer.concat(parts).toString('utf8'));
    return { state: isFrostFlow(health) ? 'ready' : 'occupied', health };
  } catch (error) {
    return { state: error.cause?.code === 'ECONNREFUSED' ? 'absent' : 'occupied' };
  }
}

function openBrowser() {
  if (process.platform !== 'win32') {
    console.log(`Open ${APP_URL} in your browser.`);
    return;
  }
  // The complete shell command uses only this constant local URL. No filenames,
  // imported data or user-entered strings are interpolated into a shell command.
  const browser = spawn('cmd.exe', ['/d', '/s', '/c', 'start "" "http://127.0.0.1:4317"'], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => console.log(`Open ${APP_URL} in your browser.`));
  browser.on('exit', code => { if (code) console.log(`Open ${APP_URL} in your browser.`); });
  browser.unref();
}

async function launch() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error(`Node.js 24 or newer is required; found ${process.versions.node}. Use the full portable package or install Node.js 24 LTS.`);
  if (!fs.existsSync(path.join(APP_ROOT, 'server.js'))) throw new Error('server.js is missing. Extract the whole FrostFlow ZIP before starting the application.');
  const current = await healthCheck();
  if (current.state === 'ready') {
    console.log(`FrostFlow ${current.health.version} is already running. Opening ${APP_URL}`);
    openBrowser();
    return;
  }
  if (current.state === 'occupied') throw new Error('Port 4317 is occupied or its service is not responding as FrostFlow 0.2. Close the earlier FrostFlow window if it is still starting, then retry. No existing process has been stopped.');

  console.log('Starting FrostFlow ERP...');
  console.log(`Business data: ${process.env.FROSTFLOW_DB || path.join(APP_ROOT, 'data', 'frostflow.sqlite')}`);
  const service = spawn(process.execPath, [path.join(APP_ROOT, 'server.js')], {
    cwd: APP_ROOT, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PORT: '4317' },
  });
  let ended = false;
  let stopping = false;
  let startError;
  let resolveExit;
  const serviceExited = new Promise(resolve => { resolveExit = resolve; });
  service.on('error', error => { startError = error; ended = true; resolveExit(1); });
  service.on('exit', (code, signal) => { ended = true; resolveExit(stopping ? 0 : code ?? (signal ? 1 : 0)); });

  const stop = () => {
    if (stopping || ended) return;
    stopping = true;
    console.log('\nStopping FrostFlow. Waiting for database connections to close...');
    // Windows delivers console Ctrl+C to both attached Node processes. On other
    // systems forward the signal explicitly. Only this launcher's child is ours.
    if (process.platform !== 'win32') service.kill('SIGINT');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', () => { stop(); if (!ended) service.kill('SIGTERM'); });

  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline && !ended && !stopping) {
    await delay(250);
    const state = await healthCheck();
    if (state.state === 'ready') { ready = true; break; }
  }
  if (!ready && !stopping) {
    if (!ended) service.kill();
    await serviceExited;
    throw new Error(startError ? `Could not start the service: ${startError.message}` : 'FrostFlow did not become ready. Check the error above, confirm the extracted folder is writable, then try again.');
  }
  if (ready) {
    console.log(`Ready: ${APP_URL}`);
    console.log('Keep this window open while working. Press Ctrl+C here to stop FrostFlow.');
    openBrowser();
  }
  const exitCode = await serviceExited;
  process.removeListener('SIGINT', stop);
  if (exitCode !== 0) throw new Error(`FrostFlow stopped with code ${exitCode}. See the service error above.`);
}

if (require.main === module) launch().catch(error => { console.error(`\n${error.message}\n`); process.exitCode = 1; });
module.exports = { launch, isFrostFlow };
