import fs from 'node:fs';
import { all, one, run } from '../db.js';
import { getOrCreateDirectConversation } from '../conversations.js';
import { MESSAGE_KINDS } from '../contracts.js';
import { notify } from '../notifications.js';
import { isOnline, sendMany } from '../realtime.js';
import { stickerFile, syncStickerPacks } from '../stickers.js';
import { cleanText, HttpError, json, parseJson } from '../utils.js';

const SENDABLE_KINDS = MESSAGE_KINDS.filter(kind => kind !== 'story_reply');

function memberIds(conversationId) { return all('SELECT user_id FROM conversation_members WHERE conversation_id=?', conversationId).map(x => Number(x.user_id)); }
/**
 * Message payloads contain viewer-specific fields (isMine, readBy), so each recipient must receive
 * a payload rendered from their own perspective rather than the sender's.
 */
function fanout(recipients, event, conversationId, messageId) {
  for (const recipient of recipients) {
    sendMany([recipient], event, { conversationId: Number(conversationId), message: getMessage(messageId, recipient) });
  }
}
function assertMember(conversationId, userId) {
  const conversation = one(`SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE c.id=? AND cm.user_id=?`, Number(conversationId), userId);
  if (!conversation) throw new HttpError(403, 'You do not have access to this conversation.');
  return conversation;
}
function person(row, prefix='') { return { id: row[`${prefix}id`], username: row[`${prefix}username`], displayName: row[`${prefix}display_name`], avatarUrl: row[`${prefix}avatar_media_id`] ? `/api/media/${row[`${prefix}avatar_media_id`]}` : null }; }

function formatMessage(row, viewerId) {
  const reactions = all(`SELECT mr.reaction,u.id,u.username,u.display_name FROM message_reactions mr JOIN users u ON u.id=mr.user_id WHERE mr.message_id=?`, row.id);
  const readBy = all(`SELECT u.id,u.username,u.display_name FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=? AND cm.user_id<>? AND cm.last_read_message_id>=?`, row.conversation_id,row.sender_id,row.id);
  return { id: row.id, conversationId: row.conversation_id, kind: row.deleted_at ? 'text' : row.kind, body: row.deleted_at ? '' : row.body,
    media: !row.deleted_at && row.media_id ? { id:row.media_id,url:`/api/media/${row.media_id}`,mimeType:row.mime_type } : null,
    sticker: !row.deleted_at && row.sticker_id ? { id:row.sticker_id,name:row.sticker_name,url:`/api/stickers/${row.sticker_id}/file` } : null,
    replyTo: row.reply_to_id ? { id:row.reply_to_id,body:row.reply_body,kind:row.reply_kind,deleted:Boolean(row.reply_deleted) } : null,
    storyId: row.story_id, sender: person(row,'sender_'), reactions: reactions.map(r=>({ reaction:r.reaction,user:{id:r.id,username:r.username,displayName:r.display_name} })),
    readBy, isMine:row.sender_id===viewerId, editedAt:row.edited_at, deletedAt:row.deleted_at, createdAt:row.created_at };
}
function getMessage(id, viewerId) {
  const row = one(`SELECT m.*,u.id sender_id,u.username sender_username,u.display_name sender_display_name,u.avatar_media_id sender_avatar_media_id,
    med.mime_type,s.name sticker_name,r.body reply_body,r.kind reply_kind,r.deleted_at reply_deleted
    FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN media med ON med.id=m.media_id LEFT JOIN stickers s ON s.id=m.sticker_id LEFT JOIN messages r ON r.id=m.reply_to_id WHERE m.id=?`, Number(id));
  return row ? formatMessage(row,viewerId) : null;
}
export function registerChatRoutes(router) {
  router.get('/api/conversations', (req,res)=>{
    const rows=all(`SELECT c.*,cm.last_read_message_id FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=? ORDER BY c.updated_at DESC`,req.session.user.id);
    const conversations=rows.map(c=>{
      const members=all(`SELECT u.* FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=? ORDER BY u.display_name`,c.id).map(u=>({...person(u),online:isOnline(u.id),lastSeenAt:u.last_seen_at}));
      const lastId=one('SELECT MAX(id) id FROM messages WHERE conversation_id=?',c.id)?.id||0;
      const last=lastId?getMessage(lastId,req.session.user.id):null;
      const unread=one('SELECT COUNT(*) count FROM messages WHERE conversation_id=? AND id>? AND sender_id<>?',c.id,c.last_read_message_id||0,req.session.user.id).count;
      return {id:c.id,kind:c.kind,title:c.kind==='direct'?(members.find(m=>m.id!==req.session.user.id)?.displayName||'Direct message'):c.title,members,lastMessage:last,unread:Number(unread),updatedAt:c.updated_at};
    });
    json(res,200,{conversations});
  });

  router.post('/api/conversations/direct',async(req,res)=>{const body=await parseJson(req);const target=one('SELECT id FROM users WHERE id=?',Number(body.userId));if(!target||target.id===req.session.user.id)throw new HttpError(400,'Choose another member.');const id=getOrCreateDirectConversation(req.session.user.id,target.id);json(res,200,{conversationId:id});});

  router.get('/api/conversations/:id/messages',(req,res,params)=>{
    const conversation=assertMember(params.id,req.session.user.id);const url=new URL(req.url,'http://local');const before=Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER);
    const rows=all(`SELECT m.*,u.id sender_id,u.username sender_username,u.display_name sender_display_name,u.avatar_media_id sender_avatar_media_id,
      med.mime_type,s.name sticker_name,r.body reply_body,r.kind reply_kind,r.deleted_at reply_deleted
      FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN media med ON med.id=m.media_id LEFT JOIN stickers s ON s.id=m.sticker_id LEFT JOIN messages r ON r.id=m.reply_to_id
      WHERE m.conversation_id=? AND m.id<? ORDER BY m.id DESC LIMIT 60`,conversation.id,before).reverse();
    json(res,200,{messages:rows.map(r=>formatMessage(r,req.session.user.id)),nextCursor:rows.length===60?rows[0].id:null});
  });

  router.post('/api/conversations/:id/messages',async(req,res,params)=>{
    const conversation=assertMember(params.id,req.session.user.id);const body=await parseJson(req);const kind=String(body.kind||'text');
    if(!SENDABLE_KINDS.includes(kind))throw new HttpError(400,'Unsupported message type.');
    const text=cleanText(body.body,4000,'Message');const mediaId=body.mediaId?Number(body.mediaId):null;const stickerId=body.stickerId?String(body.stickerId):null;const replyToId=body.replyToId?Number(body.replyToId):null;
    if(kind==='text'&&!text)throw new HttpError(400,'Message cannot be empty.');
    if(['image','video','voice'].includes(kind)&&!one("SELECT id FROM media WHERE id=? AND owner_id=? AND purpose IN ('chat','voice')",mediaId,req.session.user.id))throw new HttpError(403,'Invalid message media.');
    if(kind==='sticker'&&!one('SELECT id FROM stickers WHERE id=?',stickerId))throw new HttpError(400,'Sticker is unavailable.');
    if(replyToId&&!one('SELECT id FROM messages WHERE id=? AND conversation_id=?',replyToId,conversation.id))throw new HttpError(400,'Reply target is invalid.');
    const result=run('INSERT INTO messages(conversation_id,sender_id,kind,body,media_id,sticker_id,reply_to_id) VALUES (?,?,?,?,?,?,?)',conversation.id,req.session.user.id,kind,text,mediaId,stickerId,replyToId);
    run('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?',conversation.id);run('UPDATE conversation_members SET last_read_message_id=? WHERE conversation_id=? AND user_id=?',result.lastInsertRowid,conversation.id,req.session.user.id);
    if(stickerId)run(`INSERT INTO user_stickers(user_id,sticker_id,last_used_at,use_count) VALUES (?,?,CURRENT_TIMESTAMP,1) ON CONFLICT(user_id,sticker_id) DO UPDATE SET last_used_at=CURRENT_TIMESTAMP,use_count=use_count+1`,req.session.user.id,stickerId);
    const message=getMessage(result.lastInsertRowid,req.session.user.id);const recipients=memberIds(conversation.id).filter(id=>id!==req.session.user.id);
    fanout(recipients,'message:created',conversation.id,result.lastInsertRowid);
    recipients.forEach(id=>notify(id,req.session.user.id,'message','conversation',conversation.id,kind==='text'?text.slice(0,100):kind));json(res,201,{message});
  });

  router.post('/api/conversations/:id/read',async(req,res,params)=>{const conversation=assertMember(params.id,req.session.user.id);const body=await parseJson(req);const messageId=Number(body.messageId||0);if(messageId&&!one('SELECT id FROM messages WHERE id=? AND conversation_id=?',messageId,conversation.id))throw new HttpError(400,'Invalid message.');run(`UPDATE conversation_members SET last_read_message_id=MAX(COALESCE(last_read_message_id,0),?) WHERE conversation_id=? AND user_id=?`,messageId,conversation.id,req.session.user.id);sendMany(memberIds(conversation.id).filter(id=>id!==req.session.user.id),'message:read',{conversationId:conversation.id,userId:req.session.user.id,messageId});json(res,200,{ok:true});});

  router.post('/api/conversations/:id/typing',async(req,res,params)=>{const conversation=assertMember(params.id,req.session.user.id);const body=await parseJson(req);sendMany(memberIds(conversation.id).filter(id=>id!==req.session.user.id),'typing',{conversationId:conversation.id,userId:req.session.user.id,typing:Boolean(body.typing)});json(res,200,{ok:true});});

  router.post('/api/messages/:id/reaction',async(req,res,params)=>{const raw=one('SELECT * FROM messages WHERE id=?',Number(params.id));if(!raw)throw new HttpError(404,'Message not found.');assertMember(raw.conversation_id,req.session.user.id);const body=await parseJson(req);const selected=cleanText(body.reaction,24,'Reaction');if(selected)run(`INSERT INTO message_reactions(message_id,user_id,reaction) VALUES (?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET reaction=excluded.reaction`,raw.id,req.session.user.id,selected);else run('DELETE FROM message_reactions WHERE message_id=? AND user_id=?',raw.id,req.session.user.id);const message=getMessage(raw.id,req.session.user.id);fanout(memberIds(raw.conversation_id),'message:reaction',raw.conversation_id,raw.id);json(res,200,{message});});

  router.delete('/api/messages/:id',(req,res,params)=>{const raw=one('SELECT * FROM messages WHERE id=?',Number(params.id));if(!raw)throw new HttpError(404,'Message not found.');assertMember(raw.conversation_id,req.session.user.id);if(raw.sender_id!==req.session.user.id)throw new HttpError(403,'You can delete only your own message.');run('UPDATE messages SET deleted_at=CURRENT_TIMESTAMP,body=\'\',media_id=NULL,sticker_id=NULL WHERE id=?',raw.id);sendMany(memberIds(raw.conversation_id),'message:deleted',{conversationId:raw.conversation_id,messageId:raw.id});json(res,200,{ok:true});});

  router.get('/api/stickers',(req,res)=>{const packs=all('SELECT * FROM sticker_packs WHERE active=1 ORDER BY sort_order,name').map(p=>({...p,coverUrl:p.cover_sticker_id?`/api/stickers/${p.cover_sticker_id}/file`:null,stickers:all('SELECT id,name FROM stickers WHERE pack_id=? ORDER BY sort_order,name',p.id).map(s=>({...s,url:`/api/stickers/${s.id}/file`,favorite:Boolean(one('SELECT favorite FROM user_stickers WHERE user_id=? AND sticker_id=?',req.session.user.id,s.id)?.favorite)}))}));const recent=all(`SELECT s.id,s.name FROM user_stickers us JOIN stickers s ON s.id=us.sticker_id WHERE us.user_id=? AND us.last_used_at IS NOT NULL ORDER BY us.last_used_at DESC LIMIT 20`,req.session.user.id).map(s=>({...s,url:`/api/stickers/${s.id}/file`}));json(res,200,{packs,recent});});
  router.post('/api/stickers/reload',(req,res)=>{if(req.session.user.role!=='admin')throw new HttpError(403,'Only the group admin can reload sticker packs.');json(res,200,{stickersLoaded:syncStickerPacks()});});
  router.get('/api/stickers/:id/file',(req,res,params)=>{const sticker=one('SELECT * FROM stickers WHERE id=?',params.id);if(!sticker)throw new HttpError(404,'Sticker not found.');const file=stickerFile(sticker);if(!file||!fs.existsSync(file))throw new HttpError(404,'Sticker file is missing.');const stat=fs.statSync(file);res.writeHead(200,{'content-type':sticker.mime_type,'content-length':stat.size,'cache-control':'private, max-age=604800','x-content-type-options':'nosniff'});fs.createReadStream(file).pipe(res);});
  router.post('/api/stickers/:id/favorite',async(req,res,params)=>{if(!one('SELECT id FROM stickers WHERE id=?',params.id))throw new HttpError(404,'Sticker not found.');const body=await parseJson(req);run(`INSERT INTO user_stickers(user_id,sticker_id,favorite) VALUES (?,?,?) ON CONFLICT(user_id,sticker_id) DO UPDATE SET favorite=excluded.favorite`,req.session.user.id,params.id,body.favorite?1:0);json(res,200,{favorite:Boolean(body.favorite)});});
}
