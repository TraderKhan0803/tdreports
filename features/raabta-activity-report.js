// Raabta CRM Phase 3a/3b — Activity Report.
// Replaces the old single-filter Activity Log tab with combinable filters
// (date range, CSR, client, interaction type, outcome, outreach/system),
// a "Follow-up" column label (display-only — raabta_log.action is
// unchanged), and summary cards that recompute from whatever's currently
// filtered. Kept in its own file per the plan's ground rules; depends on
// globals defined in index.html (RB, dbGet, esc, rbFt, kpi,
// rbGroupLogsWithEdits, rbOpenEditLog), so it must load after that script.

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

function rbActRowHTML(l,nested){
  const editTag=nested?'<span style="font-size:9px;color:var(--acc);background:rgba(249,115,22,.12);border-radius:8px;padding:1px 6px;margin-right:5px;">EDITED</span>':'';
  return`<tr${nested?' style="background:rgba(249,115,22,.04);"':''}>
    <td style="white-space:nowrap;color:var(--t3);font-family:'DM Mono',monospace;font-size:10px">${rbFt(l.ts)}</td>
    <td><span style="font-weight:700;color:var(--acc)">${esc(l.user)}</span></td>
    <td style="font-weight:500;color:var(--txt)">${esc(l.customerName)}</td>
    <td style="color:var(--txt)">${editTag}${esc(l.action)}</td>
    <td>${l.outcome?`<span style="color:var(--acc);font-family:'DM Mono',monospace;font-size:10px">${esc(l.outcome)}</span>${l.note?' — '+esc(l.note):''}`:esc(l.note)||'—'}</td>
    <td><button onclick="rbOpenEditLog('${l.id}','${l.customerId}','${esc(l.customerName)}')" style="background:transparent;border:1px solid var(--bdr);border-radius:4px;padding:2px 8px;font-size:10px;color:var(--t3);cursor:pointer;white-space:nowrap;">Edit</button></td>
  </tr>`;
}

function rbActSummaryCardsHTML(threads){
  let calls=0,messages=0,complaints=0;
  const users=new Set();
  threads.forEach(t=>{
    const eff=rbActEffective(t);
    if(eff.interactionType==='call')calls++;
    if(eff.interactionType==='message')messages++;
    if((eff.outcome||'').includes('Complaint'))complaints++;
    users.add(t.user);
    (t.edits||[]).forEach(e=>users.add(e.user));
  });
  const card=(label,val,tip)=>kpi(`<span class="ec-tip" title="${esc(tip)}">${esc(label)}</span>`,val);
  return card('Calls made',calls,"Calls made — interactions whose current Type (using the latest edit if it's been corrected) is Call.")
    +card('Messages sent',messages,'Messages sent — includes templates and quick WhatsApp links, excludes status/profile changes.')
    +card('Complaints',complaints,'Complaints — current outcome is Complaint Received or Complaint Resolved.')
    +card('Active CSRs',users.size,'Active CSRs — users who logged at least one interaction in the selected range and filters, including anyone who only edited an existing one.');
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
    let qp='order=timestamp.desc&limit=1000';
    if(from)qp+='&timestamp=gte.'+encodeURIComponent(from+'T00:00:00');
    if(to)qp+='&timestamp=lte.'+encodeURIComponent(to+'T23:59:59');
    const rows=await dbGet('raabta_log',qp);
    const remoteIds=new Set(rows.map(l=>l.id));
    const localOnly=RB.alog.filter(l=>!remoteIds.has(l.id));
    const allLogs=[...rows.map(l=>({id:l.id,ts:l.timestamp,user:l.username,customerId:l.customer_id,customerName:l.customer_name,action:l.action,outcome:l.outcome,note:l.note,interactionType:l.interaction_type,category:l.category,editedFrom:l.edited_from,isEdit:!!l.is_edit})),...localOnly].sort((a,b)=>new Date(b.ts)-new Date(a.ts));

    const af=document.getElementById('rb-af');
    if(af){
      const users=[...new Set(allLogs.map(l=>l.user))].sort();
      const cur=af.value;
      af.innerHTML='<option value="">All Users</option>'+users.map(u=>`<option value="${esc(u)}"${u===cur?' selected':''}>${esc(u)}</option>`).join('');
    }
    const oSel=document.getElementById('rb-act-outcome');
    if(oSel){const cur=oSel.value;oSel.innerHTML=rbActOutcomeFilterOptions(cur);}

    const threads=rbGroupLogsWithEdits(allLogs);

    const csr=document.getElementById('rb-af')?.value||'';
    const client=(document.getElementById('rb-act-client')?.value||'').trim().toLowerCase();
    const itype=document.getElementById('rb-act-itype')?.value||'';
    const outcome=document.getElementById('rb-act-outcome')?.value||'';
    const showSystem=!!document.getElementById('rb-act-system')?.checked;

    const filtered=threads.filter(t=>{
      const eff=rbActEffective(t);
      if(!showSystem&&eff.category==='system')return false;
      if(csr&&t.user!==csr&&!(t.edits||[]).some(e=>e.user===csr))return false;
      if(client&&!(t.customerName||'').toLowerCase().includes(client))return false;
      if(itype&&eff.interactionType!==itype)return false;
      if(outcome&&eff.outcome!==outcome)return false;
      return true;
    });

    if(summaryEl)summaryEl.innerHTML=rbActSummaryCardsHTML(filtered);

    if(!filtered.length){tb.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--t3);padding:26px;font-family:\'DM Mono\',monospace">No activity matches these filters.</td></tr>';return;}
    tb.innerHTML=filtered.map(l=>rbActRowHTML(l,false)+(l.edits||[]).map(e=>rbActRowHTML(e,true)).join('')).join('');
  }catch(e){
    if(summaryEl)summaryEl.innerHTML='';
    tb.innerHTML='<tr><td colspan="6" style="color:var(--red);padding:12px;">Failed to load: '+esc(e.message)+'</td></tr>';
  }
}
