const crypto=require("crypto");

const providerKeys={
  "TeleBirr":"TELEBIRR",
  "CBE Birr":"CBE_BIRR",
  "M-Pesa":"MPESA",
  "E-Birr":"EBIRR"
};
function providerConfig(method){
  const key=providerKeys[method];
  if(!key)return null;
  return {
    method,
    depositUrl:process.env[`PAYMENT_${key}_DEPOSIT_URL`],
    withdrawalUrl:process.env[`PAYMENT_${key}_WITHDRAWAL_URL`],
    apiKey:process.env[`PAYMENT_${key}_API_KEY`],
    webhookSecret:process.env[`PAYMENT_${key}_WEBHOOK_SECRET`]
  };
}
function providerError(code,message){const error=new Error(message);error.code=code;return error}
function providerStatus(value){
  const status=String(value||"pending").toLowerCase();
  if(["success","succeeded","completed","paid","approved"].includes(status))return "success";
  if(["failed","failure","rejected","cancelled","canceled","expired"].includes(status))return "failed";
  return "pending";
}
async function callProvider(method,operation,payload,transactionId){
  const config=providerConfig(method),url=config?.[operation+"Url"];
  if(!config||!url||!config.apiKey)throw providerError("PROVIDER_NOT_CONFIGURED",`${method} payment provider is not configured`);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${config.apiKey}`,"idempotency-key":String(transactionId)},body:JSON.stringify(payload),signal:controller.signal});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw providerError("PROVIDER_REQUEST_FAILED",body.message||body.error||`${method} rejected the payment request`);
    return {
      status:providerStatus(body.status||body.payment_status||body.transaction_status),
      providerReference:String(body.reference||body.transaction_id||body.transactionId||body.id||"")||null,
      checkoutUrl:body.checkout_url||body.checkoutUrl||body.payment_url||null,
      raw:body
    };
  }catch(error){
    if(error.name==="AbortError")throw providerError("PROVIDER_TIMEOUT",`${method} payment provider timed out`);
    throw error;
  }finally{clearTimeout(timer)}
}
function verifyWebhook(method,rawBody,signature){
  const config=providerConfig(method);
  if(!config?.webhookSecret||!signature)return false;
  const expected=crypto.createHmac("sha256",config.webhookSecret).update(rawBody).digest("hex");
  const supplied=String(signature).replace(/^sha256=/i,"");
  return supplied.length===expected.length&&crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected));
}
module.exports={callProvider,providerConfig,providerStatus,verifyWebhook};
