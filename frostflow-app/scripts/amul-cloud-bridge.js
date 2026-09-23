'use strict';
const path=require('node:path');
const {openDatabase}=require('../src/db');
const {AmulSync}=require('../src/services/amul-sync');

const root=path.resolve(__dirname,'..');
const databasePath=process.env.FROSTFLOW_DB || path.join(root,'data','amul-cloud-cache.sqlite');

async function run(){
  if(!process.env.FROSTFLOW_AMUL_USER || !process.env.FROSTFLOW_AMUL_PASSWORD)throw new Error('Protected Amul read credentials are required. Run Install-Cloud-Sync.bat again.');
  const db=openDatabase(databasePath);
  try{
    const amul=new AmulSync(db,{enabled:true});
    const refreshed=await amul.sync();
    if(!refreshed)throw new Error(amul.status().error || 'Amul read-only refresh failed; the previous cloud snapshot was retained.');
  }finally{db.close();}
  const {syncOnce}=require('./cloud-sync-agent');
  await syncOnce();
}

if(require.main===module)run().catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={run};
