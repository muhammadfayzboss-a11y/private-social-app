import { listNotifications } from '../notifications.js';
import { one, run } from '../db.js';
import { config } from '../config.js';
import { pushEnabled } from '../webpush.js';
import { HttpError, json, parseJson } from '../utils.js';

export function registerActivityRoutes(router) {
  router.get('/api/activity', (req,res)=>{
    const notifications=listNotifications(req.session.user.id);
    json(res,200,{notifications,unread:notifications.filter(item=>!item.readAt).length});
  });
  router.post('/api/activity/read',async(req,res)=>{
    const body=await parseJson(req);
    if(body.all)run('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=? AND read_at IS NULL',req.session.user.id);
    else if(body.id){const item=one('SELECT id FROM notifications WHERE id=? AND user_id=?',Number(body.id),req.session.user.id);if(!item)throw new HttpError(404,'Notification not found.');run('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=?',item.id);}
    json(res,200,{ok:true});
  });
  router.get('/api/push/config',(req,res)=>json(res,200,{enabled:pushEnabled(),publicKey:config.vapidPublicKey||null}));
  router.post('/api/push/subscribe',async(req,res)=>{const body=await parseJson(req);if(!body.endpoint)throw new HttpError(400,'Invalid push subscription.');run(`INSERT INTO push_subscriptions(user_id,endpoint,subscription_json) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,subscription_json=excluded.subscription_json`,req.session.user.id,String(body.endpoint),JSON.stringify(body));json(res,201,{ok:true});});
  router.delete('/api/push/subscribe',async(req,res)=>{const body=await parseJson(req);run('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?',String(body.endpoint||''),req.session.user.id);json(res,200,{ok:true});});
}
