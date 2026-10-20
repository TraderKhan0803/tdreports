// Monthly Updates Phase 1 — live check.
//
// Paste into the browser console on tdreports.matwagroup.com while logged
// in as super. It creates a throwaway reader (profile Partner) and a test
// update for January 2000 with one tagged and one untagged item, checks what
// the reader can and cannot reach, then deletes both and prints PASS/FAIL.
//
// The deleted reader's mu_readers row stays (marked deleted), as for any
// deleted reader; it holds no notes or reads.
(async () => {
  const G = GATEWAY_URL, SUPER = authToken;
  const call = async (tok, method, path, body) => {
    const r = await fetch(G + '/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await r.json(); } catch (_) {}
    return { status: r.status, data };
  };
  const results = [];
  const check = (name, ok, detail) => results.push({ check: name, result: ok ? 'PASS' : 'FAIL', detail: detail ?? '' });
  const user = 'mu_test_' + Date.now().toString(36);
  const pw1 = crypto.randomUUID(), pw2 = crypto.randomUUID();
  let updateId = null, created = false;
  try {
    let r = await call(SUPER, 'POST', 'admin/users', { username: user, password: pw1, role: 'reader', profile: 'partner', display_name: 'MU Test Reader' });
    created = r.status === 200;
    check('super creates test reader', created, r.status);

    const lr = await fetch(G + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pw1 }) });
    const login = await lr.json();
    const T = login.token;
    check('reader logs in, must change password', lr.ok && login.role === 'reader' && login.must_change_password === true);
    r = await call(T, 'GET', 'mu/updates');
    check('mu routes refused until password changed', r.status === 403, r.status);
    r = await call(T, 'POST', 'auth/change-password', { new_password: pw2 });
    check('reader changes password', r.status === 200, r.status);
    r = await call(T, 'GET', 'auth/me');
    check('auth/me shows profile partner', r.data?.profile === 'partner', JSON.stringify(r.data));

    for (const p of ['orders?select=*&limit=1', 'products?limit=1', 'financials?limit=1', 'raabta_log?limit=1', 'campaigns?limit=1',
                     'ai_usage?limit=1', 'admin_config?limit=1', 'activity_log?limit=1', 'mu_items?limit=1', 'mu_notes?limit=1',
                     'mu_sections?limit=1', 'users?select=*', 'sessions?limit=1', 'rpc/mu_get_update', 'users/list']) {
      r = await call(T, 'GET', p);
      check('reader blocked: ' + p, r.status === 403, r.status);
    }

    // Test content, as super
    r = await call(SUPER, 'POST', 'mu_updates', [{ month: '2000-01-01', created_by: curUser.u }]);
    updateId = r.data?.[0]?.id;
    check('super creates test update', r.status === 201 && !!updateId, r.status);
    r = await call(SUPER, 'POST', 'mu_items', [
      { update_id: updateId, type: 'news', title: 'MU TEST tagged item' },
      { update_id: updateId, type: 'news', title: 'MU TEST untagged item' },
    ]);
    const tagged = (r.data || []).find((i) => i.title === 'MU TEST tagged item')?.id;
    r = await call(SUPER, 'POST', 'mu_item_tags', [{ item_id: tagged, profile: 'partner' }]);
    check('super tags one item for partner', r.status === 201, r.status);
    r = await call(T, 'GET', 'mu/update?month=2000-01-01');
    check('reader cannot see the draft', r.status === 404, r.status);
    r = await call(SUPER, 'POST', 'mu/admin/publish', { update_id: updateId, sections: [{ section_key: 'summary', profile: 'partner', payload: { text: 'MU TEST summary' } }] });
    check('super publishes', r.status === 200, JSON.stringify(r.data));
    r = await call(SUPER, 'POST', 'mu/admin/publish', { update_id: updateId, sections: [{ section_key: 'at_risk', profile: 'partner', payload: {} }] });
    check('publish refuses At-Risk for partner (hidden)', r.status === 400, JSON.stringify(r.data));

    // What the reader sees
    r = await call(T, 'GET', 'mu/update?month=2000-01-01');
    const titles = (r.data?.items || []).map((i) => i.title);
    check('reader sees the tagged item', titles.includes('MU TEST tagged item'), titles.join(', '));
    check('reader does not see the untagged item', !titles.includes('MU TEST untagged item'), titles.join(', '));
    check('reader sees only the summary section', JSON.stringify((r.data?.sections || []).map((s) => s.key)) === '["summary"]',
          JSON.stringify((r.data?.sections || []).map((s) => s.key)));
    r = await call(SUPER, 'GET', 'mu_notes?limit=1');
    check('super blocked from mu_notes table', r.status === 403, r.status);
  } catch (e) {
    check('script error', false, e.message);
  } finally {
    if (updateId) {
      const r = await call(SUPER, 'DELETE', 'mu_updates?id=eq.' + updateId);
      check('cleanup: test update deleted', r.status < 300, r.status);
    }
    if (created) {
      const r = await call(SUPER, 'POST', 'admin/users/delete', { username: user });
      check('cleanup: test reader deleted', r.status === 200, r.status);
    }
    console.table(results);
    console.log(results.every((x) => x.result === 'PASS') ? 'ALL PASS' : 'SOME CHECKS FAILED');
  }
})();
