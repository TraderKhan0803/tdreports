// Raabta CRM — Campaigns view, shared by two entry points: the Raabta
// "Campaigns" sub-tab (rbRenderCampaigns, target #rb-campaigns-body) and the
// Marketing tab's Campaigns sub-tab (renderMktCampaigns, target
// #mkt-campaigns-view, defined in index.html) -- Marketing exists for users
// without Raabta access, so it needs the exact same filters/totals/table,
// not a simplified copy. buildCampaignsView() below is the single source of
// truth for that markup; each entry point only supplies its own target
// element, id prefix (so filter inputs/tbody/guide don't collide when both
// are mounted at once) and whether to show the Window column (Marketing
// only). The two views keep independent filter selections via
// _rbCampFilters/_mktCampFilters -- filtering in one must never affect the
// other.
// Depends on globals defined in index.html (RB, esc, fmtFull, kpi,
// rbGetCampaignAttribution, rbRecipSent, rbCampaignDisplayName,
// rbOpenCampaignRecipients, rbDeleteCampaign, initSortableTable), so it
// must load after that script.
let _rbCampFilters={from:'',to:'',tpl:'',user:''};
let _mktCampFilters={from:'',to:'',tpl:'',user:''};
function _campFilterState(prefix){return prefix==='mkt'?_mktCampFilters:_rbCampFilters;}
function _campRender(prefix){if(prefix==='mkt')renderMktCampaigns();else rbRenderCampaigns();}
function rbCampSnapshotFilters(prefix){
  const g=field=>document.getElementById(prefix+'-camp-'+field)?.value||'';
  const state={from:g('from'),to:g('to'),tpl:g('tpl'),user:g('user')};
  if(prefix==='mkt')_mktCampFilters=state;else _rbCampFilters=state;
}
function rbCampFilterChanged(prefix){rbCampSnapshotFilters(prefix);_campRender(prefix);}
function rbCampClearFilters(prefix){
  if(prefix==='mkt')_mktCampFilters={from:'',to:'',tpl:'',user:''};else _rbCampFilters={from:'',to:'',tpl:'',user:''};
  _campRender(prefix);
}

function rbRenderCampaigns(){
  buildCampaignsView({targetElId:'rb-campaigns-body',tbodyId:'rb-campaigns-tbody',prefix:'rb',showWindow:false});
}

// opts:{targetElId, tbodyId, prefix, showWindow} -- sets innerHTML on
// document.getElementById(opts.targetElId); does not return anything.
function buildCampaignsView(opts){
  const{targetElId,tbodyId,prefix,showWindow}=opts;
  const el=document.getElementById(targetElId);if(!el)return;
  const camps=RB.campaigns||[];
  if(!camps.length){
    el.innerHTML='<div class="rb-empty" style="padding:40px;">No campaigns yet. Campaigns are created automatically when you send templates.</div>';
    return;
  }
  const F=_campFilterState(prefix);
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
  const fid=field=>prefix+'-camp-'+field;
  const filterBarHtml=`<div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center;padding:9px 14px;border-bottom:1px solid var(--bdr);">
      <span style="font-size:10px;color:var(--t3);letter-spacing:.5px;">FILTER</span>
      <input type="date" id="${fid('from')}" value="${F.from}" onchange="rbCampFilterChanged('${prefix}')" style="background:var(--bg);border:1px solid var(--bdr);color:var(--txt);padding:6px 10px;border-radius:var(--r2);font-family:'DM Sans',sans-serif;font-size:12px;outline:none;">
      <input type="date" id="${fid('to')}" value="${F.to}" onchange="rbCampFilterChanged('${prefix}')" style="background:var(--bg);border:1px solid var(--bdr);color:var(--txt);padding:6px 10px;border-radius:var(--r2);font-family:'DM Sans',sans-serif;font-size:12px;outline:none;">
      <select id="${fid('tpl')}" onchange="rbCampFilterChanged('${prefix}')" style="background:var(--bg);border:1px solid var(--bdr);color:var(--txt);padding:6px 10px;border-radius:var(--r2);font-family:'DM Sans',sans-serif;font-size:12px;outline:none;">
        <option value="">All Templates</option>
        ${tplOpts.map(t=>`<option value="${esc(t)}" ${F.tpl===t?'selected':''}>${esc(t)}</option>`).join('')}
      </select>
      <select id="${fid('user')}" onchange="rbCampFilterChanged('${prefix}')" style="background:var(--bg);border:1px solid var(--bdr);color:var(--txt);padding:6px 10px;border-radius:var(--r2);font-family:'DM Sans',sans-serif;font-size:12px;outline:none;">
        <option value="">All Users</option>
        ${userOpts.map(u=>`<option value="${esc(u)}" ${F.user===u?'selected':''}>${esc(u)}</option>`).join('')}
      </select>
      ${(F.from||F.to||F.tpl||F.user)?`<button onclick="rbCampClearFilters('${prefix}')" style="padding:6px 12px;background:transparent;border:1px solid var(--bdr);border-radius:var(--r2);color:var(--t2);font-size:11px;cursor:pointer;white-space:nowrap;">✕ Clear</button>`:''}
      <span style="margin-left:auto;font-size:11px;color:var(--t3);font-family:'DM Mono',monospace;">${filtered.length} of ${camps.length} campaigns</span>
    </div>`;
  const totalsHtml=`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;padding:11px 14px;border-bottom:1px solid var(--bdr);">
    ${kpi('Campaigns',filtered.length,'c-blu')}
    ${kpi('Messages Sent',tSent,'c-blu')}
    ${kpi('Orders',tOrders,'c-grn')}
    ${kpi('Revenue',fmtFull(tRev),'c-grn')}
    ${kpi('Conv Rate',tConv+'%','c-pur')}
  </div>`;
  const guideId=prefix+'-camps-guide';
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
      <td style="font-size:11px;color:var(--t3);font-family:'DM Mono',monospace;white-space:nowrap;" data-sort="${sentDate.getTime()}">${sentDate.toLocaleString('en-PK',{day:'2-digit',month:'short',year:'2-digit',hour:'2-digit',minute:'2-digit'})}</td>
      <td style="font-size:11px;color:var(--t2);">${camp.templateName?esc(camp.templateName):'—'}</td>
      <td style="font-size:11px;color:var(--t3);">${esc(camp.sentBy||'—')}</td>
      <td style="text-align:right;font-family:'DM Mono',monospace;">${sentCount}</td>
      <td style="text-align:right;font-family:'DM Mono',monospace;color:var(--grn);">${attr.orders}</td>
      <td style="text-align:right;font-family:'DM Mono',monospace;">${fmtFull(attr.revenue)}</td>
      <td style="text-align:right;font-family:'DM Mono',monospace;color:${conv>=20?'var(--grn)':conv>=10?'var(--pur)':'var(--t3)'};">${conv}%</td>
      ${showWindow?`<td style="text-align:right;font-size:10px;color:var(--t3);font-family:'DM Mono',monospace;">${camp.attributionDays}d</td>`:''}
      <td style="text-align:right;padding:4px 8px;"><button onclick="event.stopPropagation();rbDeleteCampaign('${camp.id}')" style="background:transparent;border:1px solid rgba(239,68,68,.3);border-radius:4px;color:var(--red);font-size:10px;cursor:pointer;padding:2px 6px;" title="Remove">🗑</button></td>
    </tr>`;
  }).join('');
  el.innerHTML=`<div class="rb-card" style="margin-bottom:12px;">
    <div class="rb-card-hd">
      <div>
        <div class="rb-card-title" style="color:var(--blu)">📊 Campaigns</div>
        <div style="font-size:10px;color:var(--t3);margin-top:2px;font-family:'DM Mono',monospace;">${camps.length} campaign${camps.length!==1?'s':''} · attribution from uploaded orders · click a row to see recipients</div>
      </div>
      <button onclick="const g=document.getElementById('${guideId}');g.style.display=g.style.display==='none'?'block':'none'" style="padding:4px 11px;background:transparent;border:1px solid var(--bdr);border-radius:4px;color:var(--t2);font-size:10px;cursor:pointer;white-space:nowrap;">? How it works</button>
    </div>
    <div id="${guideId}" style="display:none;padding:14px 16px;background:rgba(59,130,246,.05);border-bottom:1px solid var(--bdr);font-size:11px;color:var(--t2);line-height:1.9;">
      <strong style="color:var(--blu);display:block;margin-bottom:10px;font-size:12px;">How Campaign Attribution Works</strong>
      <strong>How orders are matched</strong><br>When you save a campaign, we record the recipient names and the moment it was saved. Every time you load this tab, we scan your uploaded Excel orders and find any order from those customers placed within the attribution window. No manual tracking needed — results update automatically as you upload new data.<br><br>
      <strong>How revenue is calculated</strong><br>Revenue = total of the <em>Total Sales</em> column for all matched orders that were actually delivered (cancelled/pending orders don't count). It uses the same figures shown across your dashboard, taken directly from your Excel uploads. Orders not yet uploaded will not appear here.<br><br>
      <strong>Conv% — Conversion rate</strong><br>Unique customers who placed at least one matched, delivered order ÷ total recipients × 100.<br>Example: 20 recipients, 4 ordered within 7 days → 20% conversion.<br><span style="color:var(--grn);">■</span> Green ≥20% &nbsp;·&nbsp; <span style="color:var(--pur);">■</span> Purple ≥10% &nbsp;·&nbsp; <span style="color:var(--t3);">■</span> Grey below 10%<br><br>
      <strong>Attribution window</strong><br>Set per campaign when you save it (1–90 days, default 7 days). Shorter windows give higher confidence that your message drove the order. 7 days works well for grocery and delivery businesses.${showWindow?' The <em>Window</em> column shows what was set for each campaign.':''}<br><br>
      <strong>Does it work for Facebook or Instagram campaigns?</strong><br>Not automatically. Attribution is name-based — only customers in your Raabta recipient list are tracked. If someone saw a social ad and ordered but wasn't in the campaign list, they won't appear here.<br><strong>Workaround:</strong> After running a social campaign, create a manual campaign in Raabta listing the customers you targeted, then check results after your window closes.<br><br>
      <strong style="color:var(--acc);">Important caveats</strong><br>· Only orders in your <strong>uploaded Excel data</strong> are counted — live or un-uploaded orders are invisible to this feature.<br>· A customer in multiple overlapping campaigns is counted in all of them — no cross-campaign de-duplication.<br>· Matching is name-based using the same normalisation as the rest of the dashboard. Name spelling variations can cause missed matches.
    </div>
    ${filterBarHtml}
    ${totalsHtml}
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;" id="${prefix}-campaigns-wrap">
      <table class="dt" style="width:100%;min-width:560px;">
        <thead><tr><th>Campaign</th><th>Date</th><th>Template</th><th>By</th><th style="text-align:right">Sent</th><th style="text-align:right">Orders</th><th style="text-align:right">Revenue</th><th style="text-align:right">Conv%</th>${showWindow?'<th style="text-align:right">Window</th>':''}<th></th></tr></thead>
        <tbody id="${tbodyId}">${rows}</tbody>
      </table>
    </div>
  </div>`;
  const sortCols=[{key:'camp',type:'text'},{key:'date',type:'date'},{key:'tpl',type:'text'},{key:'by',type:'text'},{key:'sent',type:'num',align:'right'},{key:'orders',type:'num',align:'right'},{key:'rev',type:'num',align:'right'},{key:'conv',type:'num',align:'right'}];
  if(showWindow)sortCols.push({key:'win',type:'num',align:'right'});
  sortCols.push({key:''});
  initSortableTable(tbodyId,sortCols);
}
