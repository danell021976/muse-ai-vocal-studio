// No automatic retries for paid creation requests. Uncertain results are reviewed.
function createProvider(token){
 async function request(route,body){
  const response=await fetch('https://api.replicate.com/v1'+route,{
   method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(body?120000:30000)});
  if(!response.ok)throw Object.assign(new Error('Replicate returned '+response.status+'.'),{status:response.status});
  return await response.json();
 }
 return {predictions:{
  create:({input})=>request('/models/minimax/music-2.6/predictions',{input}),
  get:id=>request('/predictions/'+encodeURIComponent(id))
 }};
}
module.exports={createProvider};
