// Shared API event and domain names. Kept dependency-free so both server and browser tooling can consume it.
export const REALTIME_EVENTS = Object.freeze([
  'connected','presence','member:joined','profile:updated','post:created','post:updated','post:deleted','post:reaction',
  'comment:created','story:created','story:deleted','story:viewed','message:created','message:deleted','message:reaction','message:read','typing','notification'
]);
export const REACTIONS = Object.freeze(['heart','laugh','wow','sad','fire','celebrate']);
export const MESSAGE_KINDS = Object.freeze(['text','image','video','voice','sticker','story_reply']);
