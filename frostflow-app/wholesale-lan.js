'use strict';
const path=require('node:path');
const {createWholesaleLanServer,resolveDatabasePath}=require('./src/wholesale-lan-server');

function start(){
  const host=process.env.FROSTFLOW_LAN_HOST||'127.0.0.1';
  const port=Number(process.env.FROSTFLOW_LAN_PORT||4318);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('FROSTFLOW_LAN_PORT must be a valid port.');
  const app=createWholesaleLanServer({
    dbPath:resolveDatabasePath(),
    authFile:process.env.FROSTFLOW_LAN_AUTH_FILE||path.join(__dirname,'data','wholesale-lan-auth.json'),
    host,
    tlsKey:process.env.FROSTFLOW_LAN_TLS_KEY||'',
    tlsCert:process.env.FROSTFLOW_LAN_TLS_CERT||'',
  });
  app.server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Wholesale LAN is already running on this port.':error.message);process.exitCode=1;});
  app.server.listen(port,host,()=>{
    const scheme=process.env.FROSTFLOW_LAN_TLS_KEY?'https':'http';
    console.log(`MR Enterprises wholesale checklist: ${scheme}://${host}:${port}/`);
    console.log('Keep this window open while staff use the checklist. Ctrl+C to stop.');
  });
  process.on('SIGINT',()=>app.close().then(()=>process.exit(0)));
  process.on('SIGTERM',()=>app.close().then(()=>process.exit(0)));
  return app;
}
if(require.main===module)start();
module.exports={start};
