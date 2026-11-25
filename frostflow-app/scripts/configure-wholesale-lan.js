'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {saveUser}=require('../src/wholesale-lan-auth');

const file=process.env.FROSTFLOW_LAN_AUTH_FILE||path.resolve(__dirname,'..','data','wholesale-lan-auth.json');
let raw='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{raw+=chunk;if(raw.length>4096)throw new Error('Setup input is too large.');});
process.stdin.on('end',()=>{
  try{
    const body=JSON.parse(raw);
    const result=saveUser(file,body);
    console.log(`${result.role.toLowerCase()} login ${result.username} saved securely.`);
  }catch(error){console.error(error.message);process.exitCode=1;}
});
