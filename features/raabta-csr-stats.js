// Raabta CRM Phase 5 — CSR Stats page.
// Drill-through only (reached by clicking a CSR's name in the Activity
// Report, never from the Raabta tab bar directly) — no nav-tab button,
// just a "← Back to Activity Report" link that reuses goBack()/navStack
// the same way Phase 4's customer drill-through does.
//
// Depends on globals from index.html (RB, dbGet, esc, rbFt, kpi, fmtFull,
// goBack, pushNav, goToDashboardCustomer, rbCurTab) and from
// raabta-activity-report.js (rbGroupLogsWithEdits indirectly via
// rbActEffective/rbActEffectiveType/rbActComplaintStatus), so both of
// those scripts must load before this one.

let _csrStatsUser=null;

function rbOpenCsrStats(username){
  pushNav('Raabta Activity Report');
  _csrStatsUser=username;
  document.querySelectorAll('.rb-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  const panel=document.getElementById('tab-rb-csr-stats');
  if(panel)panel.classList.add('active');
  rbCurTab='rb-csr-stats';
  const title=document.getElementById('rb-csr-stats-title');
  if(title)title.textContent='CSR Stats — '+username;
  const from=document.getElementById('rb-csr-from');if(from)from.value='';
  const to=document.getElementById('rb-csr-to');if(to)to.value='';
  rbCsrStatsRender();
}

function rbCsrStatsPreset(key){
  const from=document.getElementById('rb-csr-from');
  const to=document.getElementById('rb-csr-to');
  if(!from||!to)return;
  const today=new Date();
  const fmt=d=>d.toISOString().split('T')[0];
  if(key==='today'){
    from.value=fmt(today);to.value=fmt(today);
  }else if(key==='week'){
    const day=today.getDay()||7; // Sunday=0 -> treat as 7 so Monday is day 1
    const monday=new Date(today);monday.setDate(today.getDate()-day+1);
    from.value=fmt(monday);to.value=fmt(today);
  }else if(key==='month'){
    from.value=fmt(new Date(today.getFullYear(),today.getMonth(),1));to.value=fmt(today);
  }else if(key==='quarter'){
    const q=Math.floor(today.getMonth()/3);
    from.value=fmt(new Date(today.getFullYear(),q*3,1));to.value=fmt(today);
  }else{ // 'all'
    from.value='';to.value='';
  }
  rbCsrStatsRender();
}

// A thread "belongs" to a CSR if they logged it originally or made any
// edit on it — same definition the Activity Report's own CSR filter and
// "Active CSRs" card already use, kept consistent here.
function rbCsrThreadBelongs(thread,csr){
  return thread.user===csr||(thread.edits||[]).some(e=>e.user===csr);
}

function rbCsrCampaignStats(csr,fromDate,toDate){
  const camps=(RB.campaigns||[]).filter(c=>{
    if(c.sentBy!==csr)return false;
    const d=new Date(c.date);
    if(fromDate&&d<fromDate)return false;
    if(toDate&&d>toDate)return false;
    return true;
  });
  let orders=0,revenue=0;
  camps.forEach(c=>{
    const attr=rbGetCampaignAttribution(c);
    orders+=attr.orders;revenue+=attr.revenue;
  });
  return{orders,revenue,campaignCount:camps.length};
}

function rbCsrTip(label,tip){
  return`<span class="ec-tip" title="${esc(tip)}">${esc(label)}</span>`;
}

function rbCsrRecentRowHTML(t){
  const eff=rbActEffective(t);
  return`<div style="padding:8px 0;border-bottom:1px solid var(--bdr);">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px;">
      <span style="font-size:10px;color:var(--t3);font-family:'DM Mono',monospace;">${rbFt(t.ts)}</span>
      <span style="font-weight:500;color:var(--txt);cursor:pointer;text-decoration:underline;" onclick="goToDashboardCustomer('${esc(t.customerName)}','Raabta CSR Stats')">${esc(t.customerName)}</span>
      <span style="font-size:11px;color:var(--t2);">${esc(t.action)}</span>
    </div>
    ${eff.outcome?`<div style="font-size:11px;color:var(--acc);">${esc(eff.outcome)}</div>`:''}
    ${eff.note?`<div style="font-size:11px;color:var(--t2);font-style:italic;">${esc(eff.note)}</div>`:''}
  </div>`;
}

async function rbCsrStatsRender(){
  const csr=_csrStatsUser;if(!csr)return;
  const summaryEl=document.getElementById('rb-csr-stats-summary');
  const recentEl=document.getElementById('rb-csr-recent');
  if(summaryEl)summaryEl.innerHTML='<div style="color:var(--t3);font-size:11px;padding:8px;">Loading…</div>';
  try{
    const fromStr=document.getElementById('rb-csr-from')?.value||'';
    const toStr=document.getElementById('rb-csr-to')?.value||'';
    let qp='order=timestamp.desc&limit=1000';
    if(fromStr)qp+='&timestamp=gte.'+encodeURIComponent(fromStr+'T00:00:00');
    if(toStr)qp+='&timestamp=lte.'+encodeURIComponent(toStr+'T23:59:59');
    const rows=await dbGet('raabta_log',qp);
    const remoteIds=new Set(rows.map(l=>l.id));
    const localOnly=RB.alog.filter(l=>!remoteIds.has(l.id));
    const allLogs=[...rows.map(l=>({id:l.id,ts:l.timestamp,user:l.username,customerId:l.customer_id,customerName:l.customer_name,action:l.action,outcome:l.outcome,note:l.note,interactionType:l.interaction_type,category:l.category,editedFrom:l.edited_from,isEdit:!!l.is_edit})),...localOnly].sort((a,b)=>new Date(b.ts)-new Date(a.ts));
    const threads=rbGroupLogsWithEdits(allLogs);
    const mine=threads.filter(t=>rbCsrThreadBelongs(t,csr));

    let calls=0,messages=0,positive=0,total=0;
    mine.forEach(t=>{
      const eff=rbActEffective(t);
      total++;
      if(rbActEffectiveType(eff)==='call')calls++;
      if(rbActEffectiveType(eff)==='message')messages++;
      if(eff.outcome==='Responded Positively')positive++;
    });
    const responseRate=total?Math.round((positive/total)*100):0;
    const{resolved,outstanding}=rbActComplaintStatus(mine);
    const camp=rbCsrCampaignStats(csr,fromStr?new Date(fromStr+'T00:00:00'):null,toStr?new Date(toStr+'T23:59:59'):null);

    if(summaryEl)summaryEl.innerHTML=
      kpi(rbCsrTip('Calls made',"Calls made — interactions belonging to this CSR (logged or edited by them) whose current Type is Call."),calls)
      +kpi(rbCsrTip('Messages sent','Messages sent — includes templates and quick WhatsApp links, excludes status/profile changes.'),messages)
      +kpi(rbCsrTip('Response rate','Response rate — interactions with outcome Responded Positively, divided by total interactions belonging to this CSR in range.'),responseRate+'%','',positive+' of '+total+' total')
      +kpi(rbCsrTip('Complaints handled','Complaints handled — Resolved / Outstanding, based on the latest edit (if any) within each complaint thread this CSR logged or edited.'),resolved.length+' resolved','',outstanding.length+' outstanding')
      +kpi(rbCsrTip('Orders generated','Orders generated from outreach — customers who ordered within each campaign\'s attribution window, across this CSR\'s campaigns sent in range.'),camp.orders,'',fmtFull(camp.revenue)+' revenue · '+camp.campaignCount+' campaign(s)');

    if(recentEl){
      const recent=mine.slice(0,10);
      recentEl.innerHTML=recent.length?recent.map(rbCsrRecentRowHTML).join(''):'<div style="color:var(--t3);font-size:11px;padding:8px 0;">No activity in this range.</div>';
    }
  }catch(e){
    if(summaryEl)summaryEl.innerHTML='<div style="color:var(--red);font-size:11px;padding:8px;">Failed to load: '+esc(e.message)+'</div>';
    if(recentEl)recentEl.innerHTML='';
  }
}
