import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { config } from './config.js';
import './db.js';
import { requireAuth, verifyCsrf } from './auth.js';
import { Router } from './router.js';
import { connect } from './realtime.js';
import { scheduleMaintenance } from './maintenance.js';
import { syncStickerPacks } from './stickers.js';
import { HttpError, json } from './utils.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSocialRoutes } from './routes/social.js';
import { registerStoryRoutes } from './routes/stories.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerAccountRoutes } from './routes/account.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, 'public');
const router = new Router();
registerAuthRoutes(router); registerSocialRoutes(router); registerStoryRoutes(router); registerChatRoutes(router); registerActivityRoutes(router); registerAccountRoutes(router);
router.get('/api/health', (req,res)=>json(res,200,{status:'ok',time:new Date().toISOString()}), { public:true });
router.get('/api/events', (req,res)=>connect(req.session.user.id,req.session.id,req,res));
syncStickerPacks();
scheduleMaintenance();

const mimeTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
const compressible = new Set(['.html','.js','.css','.json','.webmanifest','.svg']);
const compressed = new Map();
function securityHeaders(res){
  res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','same-origin');res.setHeader('permissions-policy','camera=(self), microphone=(self), geolocation=()');
  res.setHeader('cross-origin-opener-policy','same-origin');res.setHeader('content-security-policy',"default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if(config.secureCookies)res.setHeader('strict-transport-security','max-age=31536000; includeSubDomains');
}
function serveStatic(req,res,pathname){
  let relative=pathname==='/'?'index.html':pathname.slice(1);let file=path.resolve(publicDir,relative);
  if(!file.startsWith(publicDir+path.sep))throw new HttpError(403,'Forbidden.');
  if(!fs.existsSync(file)||fs.statSync(file).isDirectory())file=path.join(publicDir,'index.html');
  if(!fs.existsSync(file))throw new HttpError(404,'Application shell not found.');
  const stat=fs.statSync(file);const extension=path.extname(file);const accepts=String(req.headers['accept-encoding']||'');
  const encoding=compressible.has(extension)&&stat.size>1024?(accepts.includes('br')?'br':accepts.includes('gzip')?'gzip':null):null;
  const revalidate=file.endsWith('index.html')||extension==='.js'||extension==='.css'||extension==='.webmanifest';
  const headers={'content-type':mimeTypes[extension]||'application/octet-stream','cache-control':revalidate?'no-cache':'public, max-age=3600'};
  if(encoding){
    const key=`${file}:${stat.mtimeMs}:${encoding}`;let payload=compressed.get(key);
    if(!payload){const source=fs.readFileSync(file);payload=encoding==='br'?brotliCompressSync(source,{params:{[zlibConstants.BROTLI_PARAM_QUALITY]:5}}):gzipSync(source,{level:6});if(compressed.size>100)compressed.clear();compressed.set(key,payload);}
    headers['content-encoding']=encoding;headers.vary='accept-encoding';headers['content-length']=payload.length;res.writeHead(200,headers);if(req.method==='HEAD')res.end();else res.end(payload);return;
  }
  headers['content-length']=stat.size;if(compressible.has(extension))headers.vary='accept-encoding';res.writeHead(200,headers);if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);
}

export const server=http.createServer(async(req,res)=>{
  securityHeaders(res);
  try{
    const url=new URL(req.url,config.origin);const pathname=url.pathname;
    if(pathname.startsWith('/api/')){
      const match=router.match(req.method,pathname);if(!match)throw new HttpError(404,'API endpoint not found.');
      if(!match.options.public){const session=requireAuth(req);verifyCsrf(req,session);}
      await match.handler(req,res,match.params,url);return;
    }
    if(!['GET','HEAD'].includes(req.method))throw new HttpError(405,'Method not allowed.');
    serveStatic(req,res,pathname);
  }catch(error){
    if(res.headersSent){if(!res.writableEnded)res.end();return;}
    const status=error instanceof HttpError?error.status:500;
    if(status===500)console.error(error);
    json(res,status,{error:{code:error.code||'INTERNAL_ERROR',message:status===500?'Something went wrong. Please try again.':error.message}});
  }
});

if(process.env.NODE_ENV!=='test')server.listen(config.port,()=>console.log(`Circle is ready at ${config.origin}`));
