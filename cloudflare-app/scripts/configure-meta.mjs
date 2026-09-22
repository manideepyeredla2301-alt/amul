const required=['META_APP_ID','META_APP_SECRET','META_ACCESS_TOKEN','META_WABA_ID','META_WEBHOOK_VERIFY_TOKEN','FROSTFLOW_CALLBACK_URL'];
for(const key of required)if(!process.env[key])throw new Error(`${key} is required.`);
const version=/^v\d+\.\d+$/.test(process.env.META_GRAPH_VERSION||'')?process.env.META_GRAPH_VERSION:'v25.0';
const graph=`https://graph.facebook.com/${version}`;
async function post(path,token,fields={}){const response=await fetch(graph+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error?.message||`Meta request failed (${response.status})`);return body;}
const appToken=`${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
const subscription=await post(`/${encodeURIComponent(process.env.META_APP_ID)}/subscriptions`,appToken,{object:'whatsapp_business_account',callback_url:process.env.FROSTFLOW_CALLBACK_URL,verify_token:process.env.META_WEBHOOK_VERIFY_TOKEN,fields:'messages',include_values:'true'});
const waba=await post(`/${encodeURIComponent(process.env.META_WABA_ID)}/subscribed_apps`,process.env.META_ACCESS_TOKEN);
console.log(JSON.stringify({callback_subscription:subscription,whatsapp_business_account:waba},null,2));
