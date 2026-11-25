'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

const SCRYPT={N:1<<15,r:8,p:1,maxmem:64*1024*1024};

function validUser(username){return /^[A-Za-z0-9._-]{3,40}$/.test(String(username||''));}
function hashPassword(password){
  if(typeof password!=='string'||password.length<8||password.length>256)throw new Error('Password must have 8 to 256 characters.');
  const salt=crypto.randomBytes(32);
  const hash=crypto.scryptSync(password,salt,64,SCRYPT);
  return {version:1,salt:salt.toString('hex'),hash:hash.toString('hex')};
}
function verifyPassword(password,record){
  try{
    if(!record||record.version!==1||typeof record.salt!=='string'||typeof record.hash!=='string')return false;
    const expected=Buffer.from(record.hash,'hex');
    if(expected.length!==64)return false;
    const actual=crypto.scryptSync(String(password||''),Buffer.from(record.salt,'hex'),64,SCRYPT);
    return crypto.timingSafeEqual(actual,expected);
  }catch{return false;}
}
function readUsers(authFile){
  const data=JSON.parse(fs.readFileSync(authFile,'utf8'));
  if(!Array.isArray(data.users)||!data.users.some(user=>user.role==='OWNER'))throw new Error('Wholesale LAN owner login is not configured.');
  return data.users;
}
function saveUser(authFile,{username,password,role}){
  username=String(username||'').trim();role=String(role||'STAFF').toUpperCase();
  if(!validUser(username))throw new Error('Username must have 3 to 40 letters, numbers, dots, dashes or underscores.');
  if(!['OWNER','STAFF'].includes(role))throw new Error('Role must be OWNER or STAFF.');
  const credential=hashPassword(password);
  let users=[];
  if(fs.existsSync(authFile))users=readUsers(authFile);
  const existing=users.findIndex(user=>user.username.toLowerCase()===username.toLowerCase());
  const entry={username,role,...credential};
  if(existing>=0){
    if(users[existing].role==='OWNER'&&role!=='OWNER'&&!users.some((user,index)=>index!==existing&&user.role==='OWNER'))throw new Error('The last owner account must remain an owner.');
    users[existing]=entry;
  }else users.push(entry);
  fs.mkdirSync(path.dirname(authFile),{recursive:true});
  const pending=authFile+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  fs.writeFileSync(pending,JSON.stringify({version:1,users},null,2)+'\n',{mode:0o600,flag:'wx'});
  fs.renameSync(pending,authFile);
  try{fs.chmodSync(authFile,0o600);}catch{}
  return {username,role};
}
module.exports={hashPassword,verifyPassword,readUsers,saveUser};
