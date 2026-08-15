// ── RAABTA: MARK SEND AS NOT DELIVERED (row action) ────────────────────────────
// A template / quick-WA send is logged optimistically at click time. If it bounced
// (dead number, wrong number), the CSR flags it from the Activity Report row via
// the "✗ Didn't deliver" button — no popup, no timer. Flagging appends an edit
// (edited_from = the send's id) with a "Not delivered" outcome, so it drops out of
// the Messages Sent KPI, and it unwinds the recipient from campaign attribution.
// The action lives on the durable log row, so past sends can be corrected too.

function rbActMarkNotDelivered(btn){
  const logId=btn.dataset.lid,cid=btn.dataset.cid,cname=btn.dataset.cname,
        action=btn.dataset.action,ts=btn.dataset.ts,user=btn.dataset.user;
  const chip='padding:7px 14px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:20px;color:var(--red);font-size:12px;font-weight:600;cursor:pointer;';
  const overlay=document.createElement('div');
  overlay.id='rb-nd-overlay';
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:600;display:flex;align-items:center;justify-content:center;';
  overlay.onclick=function(e){if(e.target===overlay)overlay.remove();};
  overlay.innerHTML='<div style="background:var(--sur);border:1px solid var(--bdr);border-radius:var(--r);padding:20px;width:340px;max-width:95vw;">'
    +'<div style="font-family:\'Syne\',sans-serif;font-size:14px;font-weight:700;color:var(--txt);margin-bottom:4px;">Mark as not delivered</div>'
    +'<div style="font-size:11px;color:var(--t3);margin-bottom:14px;">'+esc(cname)+' &mdash; why didn\'t it reach them?</div>'
    +'<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    +  '<button class="rb-nd-reason" data-reason="Not on WhatsApp" style="'+chip+'">Not on WhatsApp</button>'
    +  '<button class="rb-nd-reason" data-reason="Wrong number" style="'+chip+'">Wrong number</button>'
    +  '<button class="rb-nd-reason" data-reason="Other" style="'+chip+'">Other</button>'
    +'</div>'
    +'<div style="margin-top:14px;text-align:right;"><button id="rb-nd-cancel" style="padding:7px 14px;background:transparent;border:1px solid var(--bdr);border-radius:var(--r2);color:var(--t2);font-size:12px;cursor:pointer;">Cancel</button></div>'
    +'</div>';
  document.body.appendChild(overlay);
  document.getElementById('rb-nd-cancel').onclick=function(){overlay.remove();};
  document.addEventListener('keydown',function esc(e){if(e.key==='Escape'){overlay.remove();document.removeEventListener('keydown',esc);}});
  overlay.querySelectorAll('.rb-nd-reason').forEach(b=>{
    b.onclick=function(){overlay.remove();rbDoMarkNotDelivered(logId,cid,cname,action,ts,user,b.dataset.reason);};
  });
}

async function rbDoMarkNotDelivered(logId,cid,cname,action,ts,user,reason){
  // Append an edit that supersedes the send: "Not delivered" outcome keeps it in
  // the log as an attempt but excludes it from the Messages Sent count. The
  // original send row (nested under it) still shows the message text, so nothing
  // is lost. The note is left empty on the edit itself.
  await rbLogA(cid,cname,'Send not delivered','Not delivered: '+reason,'','message',logId,true);
  notif('Marked as not delivered — '+reason);
  // template name lives after the "— " in "Sent Template <id> — <name>"
  const dash=(action||'').indexOf('— ');
  const tname=dash>=0?action.slice(dash+2).trim():'';
  await rbUnwindCampaignSend(cname,tname,rbLocalDayKey(new Date(ts)),user);
  if(typeof rbRenderAct==='function')await rbRenderAct();
  if(RB.acid===cid){const cust=RB.custs.find(x=>x.id===cid);if(cust&&typeof rbRenderMH==='function')rbRenderMH(cust);}
  if(document.getElementById('rb-comm-overlay')&&typeof rbRefreshCommHistory==='function')await rbRefreshCommHistory(cid,cname);
}

// Flip this recipient to sent:false in the campaign(s) that recorded the send,
// matched by template name + the send's own day + the CSR who sent it. rbRecipSent
// then drops them from the sent count AND the order-matching that drives
// conversion/revenue. Matching on the send's day (not "today") means past sends
// unwind correctly.
async function rbUnwindCampaignSend(cname,tname,dayKey,user){
  if(!tname)return;
  const lc=(cname||'').toLowerCase();
  const targets=(RB.campaigns||[]).filter(c=>
    c.templateName===tname&&
    rbLocalDayKey(new Date(c.date))===dayKey&&
    (!user||(c.sentBy||'')===user));
  for(const camp of targets){
    const r=camp.recipients.find(x=>(x.name||'').toLowerCase()===lc);
    if(r&&r.sent!==false){
      r.sent=false;
      try{await sb('PATCH','campaigns?id=eq.'+encodeURIComponent(camp.id),{recipients:camp.recipients});}
      catch(e){console.error('Failed to unwind campaign recipient:',e);}
    }
  }
  if(typeof rbCurTab!=='undefined'&&rbCurTab==='rb-outreach'&&typeof rbRenderOutreach==='function')rbRenderOutreach();
  if(typeof rbCurTab!=='undefined'&&rbCurTab==='rb-campaigns'&&typeof rbRenderCampaigns==='function')rbRenderCampaigns();
  if(document.getElementById('mkt-campaigns-view')&&typeof renderMktCampaigns==='function')renderMktCampaigns();
}
