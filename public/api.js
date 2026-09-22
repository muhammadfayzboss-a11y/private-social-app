let csrfToken=null;
export function setCsrf(value){csrfToken=value||null;}
export function getCsrf(){return csrfToken;}
export async function request(path,options={}){
  const headers={accept:'application/json',...(options.headers||{})};
  if(csrfToken&&!['GET','HEAD'].includes((options.method||'GET').toUpperCase()))headers['x-csrf-token']=csrfToken;
  if(options.body&&!(options.body instanceof Blob)&&typeof options.body!=='string'){headers['content-type']='application/json';options.body=JSON.stringify(options.body);}
  const response=await fetch(path,{credentials:'same-origin',...options,headers});
  const contentType=response.headers.get('content-type')||'';const data=contentType.includes('json')?await response.json():await response.text();
  if(!response.ok){const error=new Error(data?.error?.message||`Request failed (${response.status})`);error.status=response.status;error.code=data?.error?.code;throw error;}
  return data;
}
export async function upload(file,purpose){
  return request(`/api/media?purpose=${encodeURIComponent(purpose)}`,{method:'POST',headers:{'content-type':file.type,'x-file-name':encodeURIComponent(file.name||'recording')},body:file});
}
