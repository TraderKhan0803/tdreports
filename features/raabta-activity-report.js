// Raabta CRM Phase 3a/3b — Activity Report.
// Replaces the old single-filter Activity Log tab with combinable filters
// (date range, CSR, client, interaction type, outcome, outreach/system)
// and summary cards that recompute from whatever's currently filtered.
// Kept in its own file per the plan's ground rules; depends on globals
// defined in index.html (RB, dbGet, esc, rbFt, rbGroupLogsWithEdits,
// rbOpenEditLog), so it must load after that script. Card markup is
// built locally (not via the shared kpi() helper) since these need
// click handlers and an active-state highlight that kpi() doesn't support.
//
// Filter layering: date/CSR/client/system-toggle are "general" filters —
// the summary cards always reflect just those, so clicking one card to
// drill into the table doesn't zero out the others. Type/Outcome
// (whether set via their dropdowns or by clicking a card) only narrow
// the table, on top of the general filters.

let _rbActCardFilter=null; // null | 'call' | 'message' | 'positive' | 'complaint-total' | 'complaint-resolved' | 'complaint-outstanding'
let _rbActPendingCsr=null,_rbActPendingOutcome=null; // set by rbActRestoreFilters(), consumed by the next rbRenderAct()

// Phase 4: captures everything needed to reproduce the current view, used
// when navigating away (e.g. clicking a customer or CSR name) so goBack()
// can restore the exact same filtered view, not just the tab.
function rbActSnapshotFilters(){
  return{
    from:document.getElementById('rb-act-from')?.value||'',
    to:document.getElementById('rb-act-to')?.value||'',
    csr:document.getElementById('rb-af')?.value||'',
    client:document.getElementById('rb-act-client')?.value||'',
    itype:document.getElementById('rb-act-itype')?.value||'',
    outcome:document.getElementById('rb-act-outcome')?.value||'',
    system:!!document.getElementById('rb-act-system')?.checked,
    cardFilter:_rbActCardFilter,
  };
}

// Only sets values/state — does not call rbRenderAct() itself. goBack()
// calls this, then rbSwitchTab('rb-activity'), which triggers the one
// render; calling rbRenderAct() from both places would race two renders
// against each other and could leave the stale one displayed last.
// rb-af/rb-act-outcome's <option> lists get rebuilt inside rbRenderAct()
// itself, so a plain .value= here could silently no-op if the matching
// option doesn't exist yet -- _rbActPendingCsr/Outcome let the rebuild
// pick the right one regardless of what options existed beforehand.
function rbActRestoreFilters(snap){
  const set=(id,val)=>{const el=document.getElementById(id);if(el)el.value=val;};
  set('rb-act-from',snap.from||'');
  set('rb-act-to',snap.to||'');
  set('rb-act-client',snap.client||'');
  set('rb-act-itype',snap.itype||'');
  const sysEl=document.getElementById('rb-act-system');if(sysEl)sysEl.checked=!!snap.system;
  _rbActCardFilter=snap.cardFilter||null;
  _rbActPendingCsr=snap.csr||'';
  _rbActPendingOutcome=snap.outcome||'';
}

function rbActOutcomeFilterOptions(selected){
  return'<option value="">All Outcomes</option>'+RB.outcomes.map(o=>`<option value="${esc(o.label)}"${o.label===selected?' selected':''}>${o.icon?esc(o.icon)+' ':''}${esc(o.label)}</option>`).join('');
}

// The "current" state of a thread for filtering/counting purposes — its
// most recent edit if it has one, otherwise the original itself. An edit
// that corrects the type/outcome should be reflected in reports, not the
// stale original value.
function rbActEffective(thread){
  return(thread.edits&&thread.edits.length)?thread.edits[thread.edits.length-1]:thread;
}

// interaction_type is reliable going forward, but rows logged before that
// tagging existed (and any future gap in it) can come back empty even
// though they're clearly a template send. Falls back on the action text
// rather than trusting the stored tag alone.
function rbActEffectiveType(eff){
  if(eff.interactionType)return eff.interactionType;
  return(eff.action||'').startsWith('Sent Template')?'message':'';
}

// A complaint thread is one rooted in a "Complaint Received" original.
// It only counts as resolved if a resolving edit exists *on that same
// thread* — never by matching against any other log entry.
function rbActComplaintStatus(threads){
  const resolved=[],outstanding=[];
  threads.forEach(t=>{
    if(t.outcome!=='Complaint Received')return;
    const eff=rbActEffective(t);
    (eff.outcome==='Complaint Resolved'?resolved:outstanding).push(t);
  });
  return{resolved,outstanding};
}

function rbActApplyCardFilter(key){
  _rbActCardFilter=(_rbActCardFilter===key)?null:key;
  // Sync the visible dropdowns for the two filters that map onto them
  // directly. Setting .value programmatically doesn't fire 'change', so
  // this won't loop back and clear the card filter we just set.
  const itypeSel=document.getElementById('rb-act-itype');
  const outcomeSel=document.getElementById('rb-act-outcome');
  if(itypeSel)itypeSel.value=(_rbActCardFilter==='call')?'call':(_rbActCardFilter==='message')?'message':'';
  if(outcomeSel)outcomeSel.value=(_rbActCardFilter==='positive')?'Responded Positively':'';
  rbRenderAct();
}

// Manually touching the Type/Outcome dropdowns should clear a stale card
// highlight rather than leaving it visually "active" while no longer
// matching what's actually filtered.
function rbActClearCardFilterAndRender(){
  _rbActCardFilter=null;
  rbRenderAct();
}

// kind: '' (top-level parent row, unchanged look), 'edit' (existing EDITED
// styling), or 'child' (parent_id follow-up -- same indent/border styling
// as an edit, but tagged distinctly so the two threading mechanisms don't
// look identical).
// fuTarget is resolved by the caller (rbActThreadRowsHTML), not derived from
// l itself -- an EDITED row has no parent_id of its own, so its Follow-up
// must resolve through its edited_from row (the row it's nested under here)
// rather than targeting the edit row directly.
function rbActRowHTML(l,kind,fuTarget){
  const nested=kind==='edit'||kind==='child';
  const tag=kind==='edit'?'<span style="font-size:9px;color:var(--acc);background:rgba(249,115,22,.12);border-radius:8px;padding:1px 6px;margin-right:5px;">EDITED</span>'
    :kind==='child'?'<span style="font-size:9px;color:var(--acc);background:rgba(249,115,22,.12);border-radius:8px;padding:1px 6px;margin-right:5px;">↳ FOLLOW-UP</span>'
    :'';
  const ctxTag=l.isContext?'<span style="font-size:9px;color:var(--t3);background:rgba(148,163,184,.15);border-radius:8px;padding:1px 6px;margin-right:5px;">outside date range</span>':'';
  const firstTd=nested?'border-left:2px solid var(--acc);padding-left:9px;':'';
  const trStyle=(nested?'background:rgba(249,115,22,.04);':'')+(l.isContext?'opacity:.55;':'');
  return`<tr${trStyle?` style="${trStyle}"`:''}>
    <td style="white-space:nowrap;color:var(--t3);font-family:'DM Mono',monospace;font-size:10px;${firstTd}">${rbFt(l.ts)}</td>
    <td><span style="font-weight:700;color:var(--acc);cursor:pointer;text-decoration:underline;" onclick="rbOpenCsrStats('${esc(l.user)}')">${esc(l.user)}</span></td>
    <td style="font-weight:500;color:var(--txt);cursor:pointer;text-decoration:underline;" onclick="goToDashboardCustomer('${esc(l.customerName)}','Raabta Activity Report')">${esc(l.customerName)}</td>
    <td style="color:var(--txt)">${tag}${ctxTag}${esc(l.action)}</td>
    <td>${l.outcome?`<span style="color:var(--acc);font-family:'DM Mono',monospace;font-size:10px">${esc(l.outcome)}</span>${l.note?' — '+esc(l.note):''}`:esc(l.note)||'—'}</td>
    <td style="white-space:nowrap;">
      <button onclick="rbOpenEditLog('${l.id}','${l.customerId}','${esc(l.customerName)}')" style="background:transparent;border:1px solid var(--bdr);border-radius:4px;padding:2px 8px;font-size:10px;color:var(--t3);cursor:pointer;">Edit</button>
      <button onclick="rbOpenFollowUp('${fuTarget}','${l.customerId}','${esc(l.customerName)}')" style="background:transparent;border:1px solid var(--bdr);border-radius:4px;padding:2px 8px;font-size:10px;color:var(--t3);cursor:pointer;margin-left:4px;">↳ Follow-up</button>
    </td>
  </tr>`;
}

// Attaches parent_id follow-ups onto their parent thread, the same way
// rbGroupLogsWithEdits attaches EDITED rows onto their original -- except
// keyed on parent_id instead of edited_from, and applied only within
// whatever set of threads is currently being rendered (post date/CSR/
// client/type/outcome filtering). A thread whose parent_id points outside
// that set (date filter cut it off, or the parent didn't match the current
// table filters) is left as a plain top-level row instead of vanishing.
// contextParents are out-of-range parents fetched purely so an in-range
// child isn't left floating with no thread context -- they're only
// rendered if a passed-in child actually nests onto them, and are appended
// to (not counted toward) the filtered set the caller passes in.
function rbActNestChildren(threads,contextParents){
  contextParents=contextParents||[];
  const all=[...threads,...contextParents];
  const byId=new Map(all.map(t=>[t.id,t]));
  const nested=new Set();
  threads.forEach(t=>{
    if(t.parentId&&t.parentId!==t.id&&byId.has(t.parentId)){
      const parent=byId.get(t.parentId);
      (parent.children=parent.children||[]).push(t);
      nested.add(t.id);
    }
  });
  all.forEach(t=>{if(t.children)t.children.sort((a,b)=>new Date(a.ts)-new Date(b.ts));});
  const usedContext=contextParents.filter(cp=>cp.children&&cp.children.length);
  return[...threads.filter(t=>!nested.has(t.id)),...usedContext];
}

function rbActThreadRowsHTML(t){
  // Every row within a thread -- the original, its edits, its parent_id
  // children, and each child's own edits -- shares one Follow-up target:
  // that sub-thread's root (child or original) parent_id if it has one,
  // else its own id. This keeps follow-ups one level deep no matter which
  // row in the thread the button was clicked on.
  const tTarget=t.parentId||t.id;
  let html=rbActRowHTML(t,'',tTarget)+(t.edits||[]).map(e=>rbActRowHTML(e,'edit',tTarget)).join('');
  (t.children||[]).forEach(c=>{
    const cTarget=c.parentId||c.id;
    html+=rbActRowHTML(c,'child',cTarget)+(c.edits||[]).map(e=>rbActRowHTML(e,'edit',cTarget)).join('');
  });
  return html;
}

// Calls the shared kpi() helper directly (same markup/CSS as the
// Dashboard's Total Customers/Total Orders cards, including the colored
// top-accent-line variants) and wraps its output in a clickable div,
// rather than hand-rolling equivalent markup that could drift from kpi()
// over time. kpi() itself isn't modified -- it has no concept of click
// handlers or an active-state highlight, so both are added on the wrapper.
function rbActClickableKpi(key,label,colorClass,val,tip,sub){
  const active=_rbActCardFilter===key;
  const inner=kpi(`<span class="ec-tip" title="${esc(tip)}">${esc(label)}</span>`,val,colorClass,sub);
  return`<div onclick="rbActApplyCardFilter('${key}')" style="cursor:pointer;${active?'box-shadow:0 0 0 2px var(--acc);border-radius:var(--r);':''}">${inner}</div>`;
}

// Two independently-clickable numbers can't go through a single kpi()
// call, so this still builds its own markup -- but reuses the same .kpi/
// .kpi-lbl CSS classes kpi() itself relies on, for the same look.
function rbActComplaintStatusCard(resolvedCount,outstandingCount){
  const seg=(key,label,count,color)=>{
    const active=_rbActCardFilter===key;
    return`<span onclick="event.stopPropagation();rbActApplyCardFilter('${key}')" style="cursor:pointer;display:inline-flex;flex-direction:column;align-items:center;padding:4px 10px;border-radius:6px;${active?'background:rgba(249,115,22,.15);':''}">
      <span style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:${color};">${count}</span>
      <span style="font-family:'DM Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:var(--t3);">${label}</span>
    </span>`;
  };
  return`<div class="kpi">
    <div class="kpi-lbl"><span class="ec-tip" title="Complaints — Resolved/Outstanding based on the latest edit (if any) within each complaint's own thread.">Complaint Status</span></div>
    <div style="display:flex;gap:6px;margin-top:2px;flex-wrap:wrap;">
      ${seg('complaint-resolved','Resolved',resolvedCount,'var(--grn)')}
      ${seg('complaint-outstanding','Outstanding',outstandingCount,'var(--red)')}
    </div>
  </div>`;
}

function rbActSummaryCardsHTML(threads,resolvedThreads,outstandingThreads){
  let calls=0,messages=0,complaintsTotal=0,positive=0;
  threads.forEach(t=>{
    const eff=rbActEffective(t);
    if(rbActEffectiveType(eff)==='call')calls++;
    if(rbActEffectiveType(eff)==='message')messages++;
    if((eff.outcome||'').includes('Complaint'))complaintsTotal++;
    if(eff.outcome==='Responded Positively')positive++;
  });
  return rbActClickableKpi('call','Calls made','',calls,"Calls made — interactions whose current Type (using the latest edit if it's been corrected) is Call.")
    +rbActClickableKpi('message','Messages sent','c-blu',messages,'Messages sent — includes templates and quick WhatsApp links, excludes status/profile changes.')
    +rbActClickableKpi('complaint-total','Complaints','',complaintsTotal,'Complaints — current outcome is Complaint Received or Complaint Resolved.')
    +rbActClickableKpi('positive','Positive Feedback','c-grn',positive,'Positive Feedback — current outcome is Responded Positively.')
    +rbActComplaintStatusCard(resolvedThreads.length,outstandingThreads.length);
}

async function rbRenderAct(){
  const tb=document.getElementById('rb-act-body');if(!tb)return;
  tb.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--t3);padding:16px;font-size:11px;">Loading…</td></tr>';
  const summaryEl=document.getElementById('rb-act-summary');
  try{
    // Only the date range is filtered server-side -- everything else is
    // applied below so the CSR/outcome filter dropdowns can always show
    // the full set of options for the selected range, not just whichever
    // one is currently picked.
    const from=document.getElementById('rb-act-from')?.value||'';
    const to=document.getElementById('rb-act-to')?.value||'';
    // from/to are local dates from a plain date input -- appending them to
    // the query as raw strings would have PostgREST read them as UTC,
    // shifting the effective range by the local UTC offset. Anchoring each
    // to local midnight/end-of-day before converting to ISO keeps the
    // range aligned with what the user actually picked.
    const fromDate=from?new Date(from+'T00:00:00'):null;
    const toDate=to?new Date(to+'T23:59:59.999'):null;
    let qp='order=timestamp.desc&limit=1000';
    if(fromDate)qp+='&timestamp=gte.'+encodeURIComponent(fromDate.toISOString());
    if(toDate)qp+='&timestamp=lte.'+encodeURIComponent(toDate.toISOString());
    const rows=await dbGet('raabta_log',qp);
    const remoteIds=new Set(rows.map(l=>l.id));
    const localOnly=RB.alog.filter(l=>{
      if(remoteIds.has(l.id))return false;
      const t=new Date(l.timestamp);
      if(fromDate&&t<fromDate)return false;
      if(toDate&&t>toDate)return false;
      return true;
    });
    const allLogs=[...rows.map(l=>({id:l.id,ts:l.timestamp,user:l.username,customerId:l.customer_id,customerName:l.customer_name,action:l.action,outcome:l.outcome,note:l.note,interactionType:l.interaction_type,category:l.category,editedFrom:l.edited_from,isEdit:!!l.is_edit,parentId:l.parent_id||'',alertId:l.alert_id||''})),...localOnly].sort((a,b)=>new Date(b.ts)-new Date(a.ts));

    const af=document.getElementById('rb-af');
    if(af){
      const users=[...new Set(allLogs.map(l=>l.user))].sort();
      const cur=_rbActPendingCsr!==null?_rbActPendingCsr:af.value;
      af.innerHTML='<option value="">All Users</option>'+users.map(u=>`<option value="${esc(u)}"${u===cur?' selected':''}>${esc(u)}</option>`).join('');
    }
    const oSel=document.getElementById('rb-act-outcome');
    if(oSel){
      const cur=_rbActPendingOutcome!==null?_rbActPendingOutcome:oSel.value;
      oSel.innerHTML=rbActOutcomeFilterOptions(cur);
    }
    _rbActPendingCsr=null;_rbActPendingOutcome=null;

    const threads=rbGroupLogsWithEdits(allLogs);

    // A child whose parent_id points outside the fetched date range would
    // otherwise show as a bare top-level row with no context. Fetch those
    // missing parents in one batch and render them dimmed, purely for
    // context -- they're never counted in the cards below (those are
    // computed from generalFiltered/tableFiltered only, not contextParents).
    const inRangeIds=new Set(threads.map(t=>t.id));
    const missingParentIds=[...new Set(threads.filter(t=>t.parentId&&t.parentId!==t.id&&!inRangeIds.has(t.parentId)).map(t=>t.parentId))];
    let contextParents=[];
    if(missingParentIds.length){
      const cpRows=await dbGet('raabta_log','id=in.('+missingParentIds.map(id=>encodeURIComponent(id)).join(',')+')');
      contextParents=cpRows.map(l=>({id:l.id,ts:l.timestamp,user:l.username,customerId:l.customer_id,customerName:l.customer_name,action:l.action,outcome:l.outcome,note:l.note,interactionType:l.interaction_type,category:l.category,editedFrom:l.edited_from,isEdit:!!l.is_edit,parentId:l.parent_id||'',alertId:l.alert_id||'',edits:[],isContext:true}));
    }

    // General filters -- what the summary cards reflect.
    const csr=document.getElementById('rb-af')?.value||'';
    const client=(document.getElementById('rb-act-client')?.value||'').trim().toLowerCase();
    const showSystem=!!document.getElementById('rb-act-system')?.checked;
    const generalFiltered=threads.filter(t=>{
      const eff=rbActEffective(t);
      if(!showSystem&&eff.category==='system')return false;
      if(csr&&t.user!==csr&&!(t.edits||[]).some(e=>e.user===csr))return false;
      if(client&&!(t.customerName||'').toLowerCase().includes(client))return false;
      return true;
    });

    const{resolved,outstanding}=rbActComplaintStatus(generalFiltered);
    if(summaryEl)summaryEl.innerHTML=rbActSummaryCardsHTML(generalFiltered,resolved,outstanding);

    // Table filters -- general filters plus Type/Outcome (dropdown or card).
    const resolvedIds=new Set(resolved.map(t=>t.id));
    const outstandingIds=new Set(outstanding.map(t=>t.id));
    const itype=document.getElementById('rb-act-itype')?.value||'';
    const outcome=document.getElementById('rb-act-outcome')?.value||'';
    const tableFiltered=generalFiltered.filter(t=>{
      const eff=rbActEffective(t);
      if(_rbActCardFilter==='complaint-resolved')return resolvedIds.has(t.id);
      if(_rbActCardFilter==='complaint-outstanding')return outstandingIds.has(t.id);
      if(_rbActCardFilter==='complaint-total')return(eff.outcome||'').includes('Complaint');
      if(itype&&rbActEffectiveType(eff)!==itype)return false;
      if(outcome&&eff.outcome!==outcome)return false;
      return true;
    });

    if(!tableFiltered.length){tb.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--t3);padding:26px;font-family:\'DM Mono\',monospace">No activity matches these filters.</td></tr>';return;}
    const topLevel=rbActNestChildren(tableFiltered,contextParents);
    tb.innerHTML=topLevel.map(rbActThreadRowsHTML).join('');
  }catch(e){
    if(summaryEl)summaryEl.innerHTML='';
    tb.innerHTML='<tr><td colspan="6" style="color:var(--red);padding:12px;">Failed to load: '+esc(e.message)+'</td></tr>';
  }
}
