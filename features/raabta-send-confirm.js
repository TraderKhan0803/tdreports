// ── RAABTA: POST-SEND CONFIRMATION ─────────────────────────────────────────────
// After a template/message send, WhatsApp opens in another tab. If the number is
// dead ("not on WhatsApp"), the dashboard never hears about it — it already logged
// the send optimistically. This floating bar lets the CSR flag a bounce in one tap,
// and (for blank sends with no captured text) paste what they actually sent.
// Corrections are appended as edits (edited_from = the send's id), matching the
// codebase's append-only log-edit model; reporting reads the latest edit.

let _rbSendConfirmCtx=null;
let _rbSendConfirmTimer=null;

function rbSendConfirmClose(){
  if(_rbSendConfirmTimer){clearTimeout(_rbSendConfirmTimer);_rbSendConfirmTimer=null;}
  document.getElementById('rb-send-confirm')?.remove();
  _rbSendConfirmCtx=null;
}

function rbShowSendConfirm(opts){
  const {logId,cid,cname,tid,tname,msg,campId}=opts||{};
  if(!logId)return;
  rbSendConfirmClose();
  _rbSendConfirmCtx={logId,cid,cname,tid,tname:tname||'',msg:msg||'',campId:campId||''};
  const blank=!(msg&&msg.trim());

  const bar=document.createElement('div');
  bar.id='rb-send-confirm';
  bar.style.cssText='position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:900;'
    +'background:var(--sur);border:1px solid var(--bdr);border-radius:var(--r);'
    +'box-shadow:0 8px 30px rgba(0,0,0,.45);padding:12px 14px;max-width:94vw;width:420px;'
    +"font-family:'DM Sans',sans-serif;";

  bar.innerHTML=
     '<div style="display:flex;align-items:center;gap:10px;">'
    +  '<span style="font-size:13px;color:var(--txt);flex:1;">&#10003; Sent to <b>'+esc(cname)+'</b></span>'
    +  '<button id="rb-sc-fail" style="padding:5px 11px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:var(--r2);color:var(--red);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">&#10007; Didn\'t go through</button>'
    +  '<button id="rb-sc-x" title="Dismiss" style="background:transparent;border:none;color:var(--t3);font-size:16px;cursor:pointer;line-height:1;">&times;</button>'
    +'</div>'
    +'<div id="rb-sc-reasons" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--bdr);">'
    +  '<div style="font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;font-family:\'DM Mono\',monospace;margin-bottom:6px;">Why didn\'t it send?</div>'
    +  '<div style="display:flex;gap:6px;flex-wrap:wrap;">'
    +    '<button class="rb-sc-reason" data-reason="Not on WhatsApp" style="padding:5px 10px;background:var(--sur2);border:1px solid var(--bdr);border-radius:20px;color:var(--t2);font-size:11px;cursor:pointer;">Not on WhatsApp</button>'
    +    '<button class="rb-sc-reason" data-reason="Wrong number" style="padding:5px 10px;background:var(--sur2);border:1px solid var(--bdr);border-radius:20px;color:var(--t2);font-size:11px;cursor:pointer;">Wrong number</button>'
    +    '<button class="rb-sc-reason" data-reason="Other" style="padding:5px 10px;background:var(--sur2);border:1px solid var(--bdr);border-radius:20px;color:var(--t2);font-size:11px;cursor:pointer;">Other</button>'
    +  '</div>'
    +'</div>'
    +(blank
      ? '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--bdr);">'
        +'<div style="font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;font-family:\'DM Mono\',monospace;margin-bottom:6px;">Blank message &mdash; paste what you sent (optional)</div>'
        +'<textarea id="rb-sc-note-inp" placeholder="What did you send in WhatsApp&hellip;" style="width:100%;background:var(--sur2);border:1px solid var(--bdr);color:var(--txt);padding:7px 9px;border-radius:var(--r2);font-family:\'DM Sans\',sans-serif;font-size:12px;min-height:48px;resize:vertical;outline:none;box-sizing:border-box;"></textarea>'
        +'<button id="rb-sc-note-save" style="margin-top:6px;padding:5px 12px;background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.25);border-radius:var(--r2);color:var(--grn);font-size:11px;font-weight:600;cursor:pointer;">Save message</button>'
        +'</div>'
      : '');

  document.body.appendChild(bar);

  document.getElementById('rb-sc-x').onclick=rbSendConfirmClose;
  document.getElementById('rb-sc-fail').onclick=function(){
    if(_rbSendConfirmTimer){clearTimeout(_rbSendConfirmTimer);_rbSendConfirmTimer=null;}
    document.getElementById('rb-sc-reasons').style.display='block';
  };
  bar.querySelectorAll('.rb-sc-reason').forEach(b=>{
    b.onclick=function(){rbSendConfirmFail(b.dataset.reason);};
  });
  const noteSave=document.getElementById('rb-sc-note-save');
  if(noteSave){
    noteSave.onclick=rbSendConfirmAddNote;
    document.getElementById('rb-sc-note-inp').addEventListener('focus',function(){
      if(_rbSendConfirmTimer){clearTimeout(_rbSendConfirmTimer);_rbSendConfirmTimer=null;}
    });
  }

  _rbSendConfirmTimer=setTimeout(rbSendConfirmClose,12000);
}

async function rbSendConfirmRefresh(cid,cname){
  if(RB.acid===cid){const cust=RB.custs.find(x=>x.id===cid);if(cust)rbRenderMH(cust);}
  if(document.getElementById('rb-act-body')&&typeof rbRenderAct==='function')await rbRenderAct();
  if(document.getElementById('rb-comm-overlay')&&typeof rbRefreshCommHistory==='function')await rbRefreshCommHistory(cid,cname);
}

async function rbSendConfirmFail(reason){
  const c=_rbSendConfirmCtx;if(!c)return;
  await rbLogA(c.cid,c.cname,'Send not delivered','Not delivered: '+reason,c.msg||'','message',c.logId,true);
  const cid=c.cid,cname=c.cname,tname=c.tname,campId=c.campId;
  rbSendConfirmClose();
  notif('Marked as not delivered — '+reason);
  await rbUnwindCampaignSend(cname,tname,campId);
  await rbSendConfirmRefresh(cid,cname);
}

// A bounced send shouldn't count toward campaign attribution. Sends are folded
// into a campaign two ways: the auto-grouped one (template + sender + day, via
// rbAutoSaveTemplateSend) and, for a reopened bulk campaign, that campaign
// directly. Flip this recipient's sent flag to false in whichever applies --
// rbRecipSent then drops them from both the sent count and the order matching.
async function rbUnwindCampaignSend(cname,tname,campId){
  const user=(typeof curUser!=='undefined'&&curUser)?curUser.u:'system';
  const today=rbLocalDayKey();
  const lc=(cname||'').toLowerCase();
  const targets=[];
  if(tname){
    const grouped=(RB.campaigns||[]).find(c=>c.templateName===tname&&(c.sentBy||'')===user&&rbLocalDayKey(new Date(c.date))===today);
    if(grouped)targets.push(grouped);
  }
  if(campId){
    const reopened=(RB.campaigns||[]).find(c=>c.id===campId);
    if(reopened&&!targets.includes(reopened))targets.push(reopened);
  }
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

async function rbSendConfirmAddNote(){
  const c=_rbSendConfirmCtx;if(!c)return;
  const val=(document.getElementById('rb-sc-note-inp')?.value||'').trim();
  if(!val){notif('⚠ Type what you sent first');return;}
  await rbLogA(c.cid,c.cname,'Interaction logged','',val,'message',c.logId,true);
  const cid=c.cid,cname=c.cname;
  rbSendConfirmClose();
  notif('Message saved');
  await rbSendConfirmRefresh(cid,cname);
}
