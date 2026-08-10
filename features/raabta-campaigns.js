// Raabta CRM — Campaigns tab. Moved out of rbRenderOutreach() into its own
// sub-tab; depends on globals defined in index.html (RB, esc, fmtFull,
// rbGetCampaignAttribution, rbRecipSent, rbCampaignDisplayName,
// rbOpenCampaignRecipients, rbDeleteCampaign), so it must load after that
// script.
let _rbCampFilters={from:'',to:'',tpl:'',user:''};
function rbCampSnapshotFilters(){
  const g=id=>document.getElementById(id)?.value||'';
  _rbCampFilters={from:g('rb-camp-from'),to:g('rb-camp-to'),tpl:g('rb-camp-tpl'),user:g('rb-camp-user')};
}
function rbCampFilterChanged(){rbCampSnapshotFilters();rbRenderCampaigns();}
function rbCampClearFilters(){_rbCampFilters={from:'',to:'',tpl:'',user:''};rbRenderCampaigns();}

function rbRenderCampaigns(){
  const el=document.getElementById('rb-campaigns-body');if(!el)return;
  const camps=RB.campaigns||[];
  if(!camps.length){
    el.innerHTML='<div class="rb-empty" style="padding:40px;">No campaigns yet. Campaigns are created automatically when you send templates.</div>';
    return;
  }
  const F=_rbCampFilters;
  const filtered=camps.filter(c=>{
    if(F.tpl&&(c.templateName||'')!==F.tpl)return false;
    if(F.user&&(c.sentBy||'')!==F.user)return false;
    if(F.from||F.to){
      const d=new Date(c.date);if(isNaN(d))return false;
      // compare on calendar date only, inclusive both ends
      const ds=d.toISOString().slice(0,10);
      if(F.from&&ds<F.from)return false;
      if(F.to&&ds>F.to)return false;
    }
    return true;
  });
  const tplOpts=[...new Set(camps.map(c=>c.templateName).filter(Boolean))].sort();
  const userOpts=[...new Set(camps.map(c=>c.sentBy).filter(Boolean))].sort();
  let tSent=0,tOrders=0,tRev=0;
  filtered.forEach(c=>{
    const a=rbGetCampaignAttribution(c);
    tSent+=c.recipients.filter(rbRecipSent).length;
    tOrders+=a.orders;tRev+=a.revenue;
  });
  const tConv=tSent?Math.round(tOrders/tSent*100*10)/10:0;
  const filterBarHtml=`<div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center;padding:9px 14px;border-bottom:1px solid var(--bdr);">
      <span style="font-size:10px;color:var(--t3);letter-spacing:.5px;">FILTER</span>
      <input type="date" id="rb-camp-from" value="${F.from}" onchange="rbCampFilterChanged()" style="background:var(--bg);border:1px solid var(--bdr);color:var(--txt);padding:6px 10px;border-radius:var(--r2);font-family:'DM Sans',sans-serif;font-size:12px;outline:none;">
      <input type="date" id="rb-camp-to" value="${F.to}" onchange="rbCampFilterChanged()" style="background:var(--bg);border:1px solid var(--bdr);color:var(--txt);padding:6px 10px;border-radius:var(--r2);font-family:'DM Sans',sans-serif;font-size:12px;outline:none;">
      <select id="rb-camp-tpl" onchange="rbCampFilterChanged()" style="background:var(--bg);border:1px solid var(--bdr);color:var(--txt);padding:6px 10px;border-radius:var(--r2);font-family:'DM Sans',sans-serif;font-size:12px;outline:none;">
        <option value="">All Templates</option>
        ${tplOpts.map(t=>`<option value="${esc(t)}" ${F.tpl===t?'selected':''}>${esc(t)}</option>`).join('')}
      </select>
      <select id="rb-camp-user" onchange="rbCampFilterChanged()" style="background:var(--bg);border:1px solid var(--bdr);color:var(--txt);padding:6px 10px;border-radius:var(--r2);font-family:'DM Sans',sans-serif;font-size:12px;outline:none;">
        <option value="">All Users</option>
        ${userOpts.map(u=>`<option value="${esc(u)}" ${F.user===u?'selected':''}>${esc(u)}</option>`).join('')}
      </select>
      ${(F.from||F.to||F.tpl||F.user)?`<button onclick="rbCampClearFilters()" style="padding:6px 12px;background:transparent;border:1px solid var(--bdr);border-radius:var(--r2);color:var(--t2);font-size:11px;cursor:pointer;white-space:nowrap;">✕ Clear</button>`:''}
      <span style="margin-left:auto;font-size:11px;color:var(--t3);font-family:'DM Mono',monospace;">${filtered.length} of ${camps.length} campaigns</span>
    </div>`;
  const totalCell=(label,val,color)=>`<div>
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:var(--t3);">${label}</div>
        <div style="font-size:19px;font-weight:700;font-family:'DM Mono',monospace;color:${color};">${val}</div>
      </div>`;
  const totalsHtml=`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:7px;padding:11px 14px;border-bottom:1px solid var(--bdr);">
      ${totalCell('Campaigns',filtered.length,'var(--txt)')}
      ${totalCell('Messages Sent',tSent,'var(--txt)')}
      ${totalCell('Orders',tOrders,'var(--grn)')}
      ${totalCell('Revenue',fmtFull(tRev),'var(--grn)')}
      ${totalCell('Conv Rate',tConv+'%','var(--pur)')}
    </div>`;
  if(!filtered.length){
    el.innerHTML=`<div class="rb-card" style="margin-bottom:12px;">
    <div class="rb-card-hd">
      <div>
        <div class="rb-card-title" style="color:var(--blu)">📊 Campaigns</div>
        <div style="font-size:10px;color:var(--t3);margin-top:2px;font-family:'DM Mono',monospace;">${camps.length} campaign${camps.length!==1?'s':''} · attribution from uploaded orders · click a row to see recipients</div>
      </div>
    </div>
    ${filterBarHtml}
    <div class="rb-empty" style="padding:40px;">No campaigns match these filters.</div>
  </div>`;
    return;
  }
  const rows=filtered.map(camp=>{
    const attr=rbGetCampaignAttribution(camp);
    const sentCount=camp.recipients.filter(rbRecipSent).length;
    const conv=sentCount?Math.round(attr.orders/sentCount*100):0;
    const sentDate=new Date(camp.date);
    return`<tr onclick="rbOpenCampaignRecipients('${camp.id}')" style="cursor:pointer;">
      <td style="font-size:12px;max-width:140px;word-break:break-word;">${esc(rbCampaignDisplayName(camp))}</td>
      <td style="font-size:11px;color:var(--t3);font-family:'DM Mono',monospace;white-space:nowrap;">${sentDate.toLocaleString('en-PK',{day:'2-digit',month:'short',year:'2-digit',hour:'2-digit',minute:'2-digit'})}</td>
      <td style="font-size:11px;color:var(--t2);">${camp.templateName?esc(camp.templateName):'—'}</td>
      <td style="font-size:11px;color:var(--t3);">${esc(camp.sentBy||'—')}</td>
      <td style="text-align:right;font-family:'DM Mono',monospace;">${sentCount}</td>
      <td style="text-align:right;font-family:'DM Mono',monospace;color:var(--grn);">${attr.orders}</td>
      <td style="text-align:right;font-family:'DM Mono',monospace;">${fmtFull(attr.revenue)}</td>
      <td style="text-align:right;font-family:'DM Mono',monospace;color:${conv>=20?'var(--grn)':conv>=10?'var(--pur)':'var(--t3)'};">${conv}%</td>
      <td style="text-align:right;padding:4px 8px;"><button onclick="event.stopPropagation();rbDeleteCampaign('${camp.id}')" style="background:transparent;border:1px solid rgba(239,68,68,.3);border-radius:4px;color:var(--red);font-size:10px;cursor:pointer;padding:2px 6px;" title="Remove">🗑</button></td>
    </tr>`;
  }).join('');
  el.innerHTML=`<div class="rb-card" style="margin-bottom:12px;">
    <div class="rb-card-hd">
      <div>
        <div class="rb-card-title" style="color:var(--blu)">📊 Campaigns</div>
        <div style="font-size:10px;color:var(--t3);margin-top:2px;font-family:'DM Mono',monospace;">${camps.length} campaign${camps.length!==1?'s':''} · attribution from uploaded orders · click a row to see recipients</div>
      </div>
      <button onclick="const g=document.getElementById('rb-camps-guide');g.style.display=g.style.display==='none'?'block':'none'" style="padding:4px 11px;background:transparent;border:1px solid var(--bdr);border-radius:4px;color:var(--t2);font-size:10px;cursor:pointer;white-space:nowrap;">? How it works</button>
    </div>
    <div id="rb-camps-guide" style="display:none;padding:14px 16px;background:rgba(59,130,246,.05);border-bottom:1px solid var(--bdr);font-size:11px;color:var(--t2);line-height:1.9;">
      <strong style="color:var(--blu);display:block;margin-bottom:10px;font-size:12px;">How Campaign Attribution Works</strong>
      <strong>How orders are matched</strong><br>When you save a campaign, we record the recipient names and the moment it was saved. Every time you load this tab, we scan your uploaded Excel orders and find any order from those customers placed within the attribution window. No manual tracking needed — results update automatically as you upload new data.<br><br>
      <strong>How revenue is calculated</strong><br>Revenue = total of the <em>Total Sales</em> column for all matched orders that were actually delivered (cancelled/pending orders don't count). It uses the same figures shown across your dashboard, taken directly from your Excel uploads. Orders not yet uploaded will not appear here.<br><br>
      <strong>Conv% — Conversion rate</strong><br>Unique customers who placed at least one matched, delivered order ÷ total recipients × 100.<br>Example: 20 recipients, 4 ordered within 7 days → 20% conversion.<br><span style="color:var(--grn);">■</span> Green ≥20% &nbsp;·&nbsp; <span style="color:var(--pur);">■</span> Purple ≥10% &nbsp;·&nbsp; <span style="color:var(--t3);">■</span> Grey below 10%<br><br>
      <strong>Attribution window</strong><br>Set per campaign when you save it (1–90 days, default 7 days). Shorter windows give higher confidence that your message drove the order. 7 days works well for grocery and delivery businesses.<br><br>
      <strong>Does it work for Facebook or Instagram campaigns?</strong><br>Not automatically. Attribution is name-based — only customers in your Raabta recipient list are tracked. If someone saw a social ad and ordered but wasn't in the campaign list, they won't appear here.<br><strong>Workaround:</strong> After running a social campaign, create a manual campaign in Raabta listing the customers you targeted, then check results after your window closes.<br><br>
      <strong style="color:var(--acc);">Important caveats</strong><br>· Only orders in your <strong>uploaded Excel data</strong> are counted — live or un-uploaded orders are invisible to this feature.<br>· A customer in multiple overlapping campaigns is counted in all of them — no cross-campaign de-duplication.<br>· Matching is name-based using the same normalisation as the rest of the dashboard. Name spelling variations can cause missed matches.
    </div>
    ${filterBarHtml}
    ${totalsHtml}
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
      <table class="dt" style="width:100%;min-width:560px;">
        <thead><tr><th>Campaign</th><th>Date</th><th>Template</th><th>By</th><th style="text-align:right">Sent</th><th style="text-align:right">Orders</th><th style="text-align:right">Revenue</th><th style="text-align:right">Conv%</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}
