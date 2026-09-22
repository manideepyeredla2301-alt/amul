const { createApplication } = require('./src/http-app');
const { DB_PATH } = require('./src/db');

function start() {
  const app = createApplication({ dbPath: process.env.FROSTFLOW_DB || DB_PATH });
  const port = Number(process.env.PORT || 4317);
  app.server.listen(port, '127.0.0.1', () => console.log(`FrostFlow ERP: http://127.0.0.1:${app.server.address().port}\nOffline business operations ready. Ctrl+C to stop.`));
  app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `FrostFlow may already be running. Open http://127.0.0.1:${port}` : error.message); process.exitCode = 1; });
  process.on('SIGINT', () => app.close().then(() => process.exit(0)));
  process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
  return app;
}
if (require.main === module) start();
module.exports = { createApplication, start };
