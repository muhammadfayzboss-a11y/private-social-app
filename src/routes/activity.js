import { listNotifications } from '../notifications.js';
import { one, run } from '../db.js';
import { config } from '../config.js';
import { pushEnabled } from '../webpush.js';
import { HttpError, json, parseJson } from '../utils.js';

/**
 * The server later POSTs to this URL, so it must be a real HTTPS push service endpoint, never an
 * internal address. Plain http is accepted only outside production (local test push services).
 */
function validPushEndpoint(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  if (String(value).length > 1000) return null;
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && config.env !== 'production') return url.href;
  return null;
}

export function registerActivityRoutes(router) {
  router.get('/api/activity', (req,res)=>{
    const notifications=listNotifications(req.session.user.id);
    const unread=Number(one('SELECT COUNT(*) count FROM notifications WHERE user_id=? AND read_at IS NULL',req.session.user.id).count);
    json(res,200,{notifications,unread});
  });
  router.post('/api/activity/read',async(req,res)=>{
    const body=await parseJson(req);
    if(body.all)run('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=? AND read_at IS NULL',req.session.user.id);
    else if(body.id){const item=one('SELECT id FROM notifications WHERE id=? AND user_id=?',Number(body.id),req.session.user.id);if(!item)throw new HttpError(404,'Notification not found.');run('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=?',item.id);}
    json(res,200,{ok:true});
  });
  router.get('/api/push/config',(req,res)=>json(res,200,{enabled:pushEnabled(),publicKey:config.vapidPublicKey||null}));
  router.post('/api/push/subscribe',async(req,res)=>{
    const body=await parseJson(req);const endpoint=validPushEndpoint(body.endpoint);
    if(!endpoint||typeof body.keys?.p256dh!=='string'||typeof body.keys?.auth!=='string')throw new HttpError(400,'Invalid push subscription.');
    const subscription={endpoint,keys:{p256dh:body.keys.p256dh.slice(0,200),auth:body.keys.auth.slice(0,100)}};
    run(`INSERT INTO push_subscriptions(user_id,session_id,endpoint,subscription_json) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,session_id=excluded.session_id,subscription_json=excluded.subscription_json`,req.session.user.id,req.session.id,endpoint,JSON.stringify(subscription));
    json(res,201,{ok:true});
  });
  router.delete('/api/push/subscribe',async(req,res)=>{const body=await parseJson(req);run('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=? AND session_id=?',String(body.endpoint||''),req.session.user.id,req.session.id);json(res,200,{ok:true});});
}
