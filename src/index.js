const X_API = 'https://api.x.com/2';
const X_AUTHORIZE = 'https://x.com/i/oauth2/authorize';
const SESSION_COOKIE = 'xsm_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const MAX_LOG_MESSAGE = 1000;

export default {
  async fetch(request, env, ctx) {
    try {
      return await router(request, env, ctx);
    } catch (err) {
      console.error(err);
      return htmlPage('Hata', `<div class="alert danger"><b>Sunucu hatası:</b> ${escapeHtml(err?.message || String(err))}</div>`, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduledPosts(env));
  }
};

async function router(request, env, ctx) {
  validateEnv(env);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === '/healthz') return json({ ok: true, now: new Date().toISOString() });
  if (method === 'GET' && path === '/login') return loginPage(request);
  if (method === 'POST' && path === '/login') return handleLogin(request, env);
  if (method === 'POST' && path === '/logout') {
    ensureSameOrigin(request);
    return redirect('/', clearSessionCookie(request));
  }

  const session = await getSession(request, env);
  if (!session) return redirect('/login');

  if (method !== 'GET' && method !== 'HEAD') ensureSameOrigin(request);

  if (method === 'GET' && path === '/') return dashboard(request, env);
  if (method === 'GET' && path === '/connect/x') return startXOAuth(request, env);
  if (method === 'GET' && path === '/oauth/x/callback') return finishXOAuth(request, env);
  if (method === 'POST' && path === '/accounts/remove') return removeAccount(request, env);
  if (method === 'POST' && path === '/post/now') return publishNow(request, env);
  if (method === 'POST' && path === '/post/schedule') return schedulePosts(request, env);
  if (method === 'POST' && path === '/scheduled/cancel') return cancelScheduled(request, env);
  if (method === 'POST' && path === '/engage') return manualEngage(request, env);
  if (method === 'GET' && path === '/api/logs') return apiLogs(env);

  return htmlPage('Bulunamadı', '<div class="alert danger">Sayfa bulunamadı.</div>', 404);
}

function validateEnv(env) {
  const required = ['DB', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'X_CLIENT_ID'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Eksik env/secret: ${missing.join(', ')}`);
}

function loginPage(request, message = '') {
  return htmlPage('Giriş', `
    ${message ? `<div class="alert danger">${escapeHtml(message)}</div>` : ''}
    <div class="card narrow">
      <h1>X Safe Worker Manager</h1>
      <p class="muted">Admin parolanla giriş yap.</p>
      <form method="post" action="/login" class="stack">
        <label>Admin parola
          <input type="password" name="password" autocomplete="current-password" required autofocus>
        </label>
        <button type="submit">Giriş yap</button>
      </form>
    </div>
  `);
}

async function handleLogin(request, env) {
  ensureSameOrigin(request, true);
  const form = await request.formData();
  const password = String(form.get('password') || '');
  if (!safeEqual(password, env.ADMIN_PASSWORD)) return loginPage(request, 'Parola hatalı.');

  const token = await signSession({ sub: 'admin', exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }, env.SESSION_SECRET);
  return redirect('/', setSessionCookie(request, token, SESSION_TTL_SECONDS));
}

async function dashboard(request, env) {
  const url = new URL(request.url);
  const flash = url.searchParams.get('m') || '';
  const accounts = await listAccounts(env);
  const scheduled = await listScheduled(env);
  const logs = await listAuditLogs(env, 30);

  const accountsRows = accounts.length ? accounts.map((a) => `
    <tr>
      <td><b>@${escapeHtml(a.username)}</b><br><span class="muted">${escapeHtml(a.name || '')}</span></td>
      <td><code>${escapeHtml(a.x_user_id)}</code></td>
      <td>${a.token_expires_at ? escapeHtml(new Date(a.token_expires_at * 1000).toISOString()) : '-'}</td>
      <td>${a.last_error ? `<span class="dangerText">${escapeHtml(a.last_error.slice(0, 120))}</span>` : '<span class="okText">Aktif</span>'}</td>
      <td>
        <form method="post" action="/accounts/remove" onsubmit="return confirm('Bu hesabı panelden kaldırmak istiyor musun?')">
          <input type="hidden" name="id" value="${escapeHtml(a.id)}">
          <button class="secondary dangerBtn" type="submit">Kaldır</button>
        </form>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="5" class="muted">Henüz hesap bağlanmadı.</td></tr>';

  const contentFields = accounts.length ? accounts.map((a) => `
    <div class="accountBox">
      <label class="rowLabel">
        <input type="checkbox" name="account_id" value="${escapeHtml(a.id)}">
        <span><b>@${escapeHtml(a.username)}</b> için içerik</span>
      </label>
      <textarea name="content_${escapeHtml(a.id)}" rows="4" maxlength="4000" placeholder="Bu hesap için özgün post metni..."></textarea>
    </div>
  `).join('') : '<p class="muted">Önce hesap bağla.</p>';

  const accountOptions = accounts.map((a) => `<option value="${escapeHtml(a.id)}">@${escapeHtml(a.username)} — ${escapeHtml(a.name || '')}</option>`).join('');

  const scheduledRows = scheduled.length ? scheduled.map((p) => `
    <tr>
      <td><b>@${escapeHtml(p.username || '')}</b><br><span class="muted">${escapeHtml(p.content.slice(0, 120))}${p.content.length > 120 ? '…' : ''}</span></td>
      <td>${escapeHtml(new Date(p.scheduled_at * 1000).toISOString())}</td>
      <td><span class="badge">${escapeHtml(p.status)}</span></td>
      <td>${p.result_post_id ? `<code>${escapeHtml(p.result_post_id)}</code>` : (p.error ? `<span class="dangerText">${escapeHtml(p.error.slice(0, 160))}</span>` : '-')}</td>
      <td>
        ${p.status === 'queued' ? `<form method="post" action="/scheduled/cancel"><input type="hidden" name="id" value="${escapeHtml(p.id)}"><button class="secondary" type="submit">İptal</button></form>` : ''}
      </td>
    </tr>
  `).join('') : '<tr><td colspan="5" class="muted">Planlı post yok.</td></tr>';

  const logRows = logs.length ? logs.map((l) => `
    <tr>
      <td>${escapeHtml(new Date(l.ts * 1000).toISOString())}</td>
      <td><code>${escapeHtml(l.action)}</code></td>
      <td>${l.status ? escapeHtml(String(l.status)) : '-'}</td>
      <td>${escapeHtml(l.target || '')}</td>
      <td class="small">${escapeHtml(l.message || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="5" class="muted">Log yok.</td></tr>';

  return htmlPage('Panel', `
    <div class="topbar">
      <div>
        <h1>X Safe Worker Manager</h1>
        <p class="muted">Yetkili hesaplar için güvenli yayınlama, planlama ve tekil manuel aksiyon paneli.</p>
      </div>
      <form method="post" action="/logout"><button class="secondary" type="submit">Çıkış</button></form>
    </div>

    ${flash ? `<div class="alert ok">${escapeHtml(flash)}</div>` : ''}

    <div class="alert warn">
      Bu panel aynı metni birden fazla hesaba göndermeyi engeller. Beğeni/repost işlemleri toplu değil, yalnızca tek hesap ve tek post için manuel kullanıcı aksiyonu olarak çalışır.
    </div>

    <section class="card">
      <div class="split">
        <div>
          <h2>Bağlı hesaplar</h2>
          <p class="muted">Her hesap X OAuth ekranından ayrı ayrı yetkilendirilir; ham auth token yapıştırmana gerek yoktur.</p>
        </div>
        <a class="button" href="/connect/x">+ X hesabı bağla</a>
      </div>
      <div class="tableWrap">
        <table>
          <thead><tr><th>Hesap</th><th>X User ID</th><th>Token bitiş</th><th>Durum</th><th></th></tr></thead>
          <tbody>${accountsRows}</tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>Yayın kampanyası</h2>
      <p class="muted">Birden fazla hesap seçersen her hesap için farklı metin girmen gerekir. Zamanlama alanı tarayıcındaki yerel saatle girilir ve UTC'ye çevrilir.</p>
      <form method="post" class="stack campaignForm">
        ${contentFields}
        <label class="rowLabel">
          <input type="checkbox" name="compliance_ack" value="1" required>
          <span>Bu içeriklerin yetkili hesaplar için özgün, yanıltıcı olmayan ve X kurallarına uygun olduğunu onaylıyorum.</span>
        </label>
        <label>Planlama zamanı
          <input type="datetime-local" id="scheduledLocal">
          <input type="hidden" name="scheduled_at" id="scheduledAtUtc">
        </label>
        <div class="actions">
          <button type="submit" formaction="/post/now">Şimdi yayınla</button>
          <button type="submit" formaction="/post/schedule" class="secondary">Planla</button>
        </div>
      </form>
    </section>

    <section class="card">
      <h2>Tekil manuel aksiyon</h2>
      <p class="muted">Bu bölüm toplu çalışmaz: bir hesap + bir post. Quote-post, X API planına göre Enterprise gerektirebilir.</p>
      <form method="post" action="/engage" class="stack">
        <label>Hesap
          <select name="account_id" required>${accountOptions}</select>
        </label>
        <label>Post linki veya ID
          <input name="tweet" placeholder="https://x.com/user/status/123... veya 123..." required>
        </label>
        <label>Aksiyon
          <select name="action" required>
            <option value="repost">Repost</option>
            <option value="like">Beğen</option>
            <option value="quote">Alıntı post</option>
          </select>
        </label>
        <label>Alıntı metni / not
          <textarea name="quote_text" rows="3" maxlength="4000" placeholder="Sadece alıntı post seçersen kullanılır."></textarea>
        </label>
        <label class="rowLabel">
          <input type="checkbox" name="manual_ack" value="1" required>
          <span>Bu aksiyonun gerçek, manuel ve spam/manipülasyon amaçlı olmadığını onaylıyorum.</span>
        </label>
        <button type="submit">Tekil aksiyonu çalıştır</button>
      </form>
    </section>

    <section class="card">
      <h2>Planlı postlar</h2>
      <div class="tableWrap">
        <table>
          <thead><tr><th>İçerik</th><th>Zaman UTC</th><th>Durum</th><th>Sonuç</th><th></th></tr></thead>
          <tbody>${scheduledRows}</tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>Audit log</h2>
      <div class="tableWrap">
        <table>
          <thead><tr><th>Zaman UTC</th><th>Aksiyon</th><th>Status</th><th>Hedef</th><th>Mesaj</th></tr></thead>
          <tbody>${logRows}</tbody>
        </table>
      </div>
    </section>

    <script>
      for (const form of document.querySelectorAll('.campaignForm')) {
        form.addEventListener('submit', function () {
          const local = document.getElementById('scheduledLocal').value;
          document.getElementById('scheduledAtUtc').value = local ? new Date(local).toISOString() : '';
        });
      }
    </script>
  `);
}

async function startXOAuth(request, env) {
  const url = new URL(request.url);
  const redirectUri = getBaseUrl(request, env) + '/oauth/x/callback';
  const state = randomId();
  const codeVerifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(64)));
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const now = nowSeconds();

  await env.DB.prepare(`INSERT INTO oauth_states(state, code_verifier, redirect_uri, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(state, codeVerifier, redirectUri, now, now + 600)
    .run();

  const auth = new URL(X_AUTHORIZE);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', env.X_CLIENT_ID);
  auth.searchParams.set('redirect_uri', redirectUri);
  auth.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access like.write');
  auth.searchParams.set('state', state);
  auth.searchParams.set('code_challenge', codeChallenge);
  auth.searchParams.set('code_challenge_method', 'S256');

  return redirect(auth.toString());
}

async function finishXOAuth(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) return redirect('/?m=' + encodeURIComponent(`OAuth reddedildi: ${error}`));
  if (!code || !state) return redirect('/?m=' + encodeURIComponent('OAuth callback eksik parametre içeriyor.'));

  const row = await env.DB.prepare(`SELECT * FROM oauth_states WHERE state = ?`).bind(state).first();
  if (!row || row.expires_at < nowSeconds()) return redirect('/?m=' + encodeURIComponent('OAuth state süresi doldu veya geçersiz.'));

  const token = await exchangeCodeForToken(env, code, row.code_verifier, row.redirect_uri);
  const me = await getXMe(token.access_token);
  const now = nowSeconds();
  const id = randomId();
  const expiresAt = token.expires_in ? now + Number(token.expires_in) : null;
  const accessEnc = await encryptString(env, token.access_token);
  const refreshEnc = token.refresh_token ? await encryptString(env, token.refresh_token) : null;

  await env.DB.prepare(`
    INSERT INTO accounts(id, x_user_id, username, name, scope, token_type, access_token_enc, refresh_token_enc, token_expires_at, active, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
    ON CONFLICT(x_user_id) DO UPDATE SET
      username = excluded.username,
      name = excluded.name,
      scope = excluded.scope,
      token_type = excluded.token_type,
      access_token_enc = excluded.access_token_enc,
      refresh_token_enc = COALESCE(excluded.refresh_token_enc, accounts.refresh_token_enc),
      token_expires_at = excluded.token_expires_at,
      active = 1,
      last_error = NULL,
      updated_at = excluded.updated_at
  `).bind(id, me.id, me.username, me.name || '', token.scope || '', token.token_type || 'bearer', accessEnc, refreshEnc, expiresAt, now, now).run();

  await env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(state).run();
  await logAudit(env, { action: 'account.connect', accountId: me.id, status: 200, target: '@' + me.username, message: 'OAuth account connected' });
  return redirect('/?m=' + encodeURIComponent(`@${me.username} bağlandı.`));
}

async function exchangeCodeForToken(env, code, codeVerifier, redirectUri) {
  const body = new URLSearchParams();
  body.set('code', code);
  body.set('grant_type', 'authorization_code');
  body.set('redirect_uri', redirectUri);
  body.set('code_verifier', codeVerifier);
  if (!env.X_CLIENT_SECRET) body.set('client_id', env.X_CLIENT_ID);

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (env.X_CLIENT_SECRET) headers.Authorization = basicAuth(env.X_CLIENT_ID, env.X_CLIENT_SECRET);

  const res = await fetch(`${X_API}/oauth2/token`, { method: 'POST', headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth token exchange failed: ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function refreshAccessToken(env, account) {
  if (!account.refresh_token_enc) throw new Error(`@${account.username} için refresh token yok; hesabı yeniden bağla.`);
  const refreshToken = await decryptString(env, account.refresh_token_enc);
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  if (!env.X_CLIENT_SECRET) body.set('client_id', env.X_CLIENT_ID);

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (env.X_CLIENT_SECRET) headers.Authorization = basicAuth(env.X_CLIENT_ID, env.X_CLIENT_SECRET);

  const res = await fetch(`${X_API}/oauth2/token`, { method: 'POST', headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token refresh failed for @${account.username}: ${res.status} ${text.slice(0, 500)}`);
  const token = JSON.parse(text);
  const now = nowSeconds();
  const accessEnc = await encryptString(env, token.access_token);
  const refreshEnc = token.refresh_token ? await encryptString(env, token.refresh_token) : account.refresh_token_enc;
  const expiresAt = token.expires_in ? now + Number(token.expires_in) : null;

  await env.DB.prepare(`UPDATE accounts SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?, scope = COALESCE(?, scope), last_error = NULL, updated_at = ? WHERE id = ?`)
    .bind(accessEnc, refreshEnc, expiresAt, token.scope || null, now, account.id)
    .run();

  return token.access_token;
}

async function getValidAccessToken(env, account) {
  const expiresAt = Number(account.token_expires_at || 0);
  if (expiresAt && expiresAt > nowSeconds() + 120) return decryptString(env, account.access_token_enc);
  return refreshAccessToken(env, account);
}

async function getXMe(accessToken) {
  const res = await fetch(`${X_API}/users/me?user.fields=id,name,username,created_at,profile_image_url,verified`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`users/me failed: ${res.status} ${text.slice(0, 500)}`);
  const payload = JSON.parse(text);
  if (!payload.data?.id) throw new Error('users/me yanıtında kullanıcı bilgisi yok.');
  return payload.data;
}

async function publishNow(request, env) {
  const form = await request.formData();
  const selected = getStringArray(form, 'account_id');
  if (!selected.length) return redirect('/?m=' + encodeURIComponent('En az bir hesap seç.'));
  if (!form.get('compliance_ack')) return redirect('/?m=' + encodeURIComponent('Uygunluk onayı gerekli.'));
  const entries = await prepareCampaignEntries(env, form, selected);
  const results = [];

  for (const entry of entries) {
    try {
      const postId = await createPost(env, entry.account, { text: entry.content });
      await logAudit(env, { action: 'post.create', accountId: entry.account.id, status: 201, target: postId, message: `@${entry.account.username}` });
      results.push(`@${entry.account.username}: yayınlandı (${postId})`);
    } catch (err) {
      await markAccountError(env, entry.account.id, err.message);
      await logAudit(env, { action: 'post.create', accountId: entry.account.id, status: 500, target: 'create', message: err.message });
      results.push(`@${entry.account.username}: hata (${err.message.slice(0, 120)})`);
    }
  }

  return redirect('/?m=' + encodeURIComponent(results.join(' | ')));
}

async function schedulePosts(request, env) {
  const form = await request.formData();
  const selected = getStringArray(form, 'account_id');
  const scheduledIso = String(form.get('scheduled_at') || '');
  if (!selected.length) return redirect('/?m=' + encodeURIComponent('En az bir hesap seç.'));
  if (!form.get('compliance_ack')) return redirect('/?m=' + encodeURIComponent('Uygunluk onayı gerekli.'));
  if (!scheduledIso) return redirect('/?m=' + encodeURIComponent('Planlama zamanı gerekli.'));

  const scheduledAt = Math.floor(Date.parse(scheduledIso) / 1000);
  if (!Number.isFinite(scheduledAt)) return redirect('/?m=' + encodeURIComponent('Planlama zamanı geçersiz.'));
  if (scheduledAt < nowSeconds() + 60) return redirect('/?m=' + encodeURIComponent('Planlama zamanı en az 1 dakika sonrası olmalı.'));

  const entries = await prepareCampaignEntries(env, form, selected);
  const campaignId = randomId();
  const now = nowSeconds();
  const batch = entries.map((entry) => env.DB.prepare(`
    INSERT INTO scheduled_posts(id, campaign_id, account_id, content, scheduled_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
  `).bind(randomId(), campaignId, entry.account.id, entry.content, scheduledAt, now, now));

  await env.DB.batch(batch);
  await logAudit(env, { action: 'post.schedule', status: 200, target: campaignId, message: `${entries.length} post scheduled for ${new Date(scheduledAt * 1000).toISOString()}` });
  return redirect('/?m=' + encodeURIComponent(`${entries.length} post planlandı.`));
}

async function prepareCampaignEntries(env, form, selected) {
  const uniqueSelected = [...new Set(selected)];
  const accounts = [];
  for (const id of uniqueSelected) {
    const account = await getAccount(env, id);
    if (!account) throw new Error(`Hesap bulunamadı: ${id}`);
    const content = String(form.get(`content_${id}`) || '').trim();
    if (!content) throw new Error(`@${account.username} için içerik boş.`);
    accounts.push({ account, content });
  }
  if (accounts.length > 1) {
    const normalized = accounts.map((e) => normalizePostText(e.content));
    const duplicate = normalized.find((text, idx) => normalized.indexOf(text) !== idx);
    if (duplicate) throw new Error('Birden fazla hesap seçildiğinde birebir aynı metin gönderilemez. Her hesap için özgün metin gir.');
  }
  return accounts;
}

function normalizePostText(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

async function createPost(env, account, body) {
  const token = await getValidAccessToken(env, account);
  const res = await fetch(`${X_API}/tweets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`X create post failed: ${res.status} ${text.slice(0, 500)}`);
  const payload = JSON.parse(text);
  return payload.data?.id || 'unknown';
}

async function manualEngage(request, env) {
  const form = await request.formData();
  if (!form.get('manual_ack')) return redirect('/?m=' + encodeURIComponent('Manuel aksiyon onayı gerekli.'));

  const action = String(form.get('action') || '');
  const accountId = String(form.get('account_id') || '');
  const tweetId = extractTweetId(String(form.get('tweet') || ''));
  const quoteText = String(form.get('quote_text') || '').trim();

  if (!['like', 'repost', 'quote'].includes(action)) return redirect('/?m=' + encodeURIComponent('Aksiyon geçersiz.'));
  if (!tweetId) return redirect('/?m=' + encodeURIComponent('Post ID/link geçersiz.'));
  const account = await getAccount(env, accountId);
  if (!account) return redirect('/?m=' + encodeURIComponent('Hesap bulunamadı.'));

  try {
    let message = '';
    if (action === 'like') {
      await likePost(env, account, tweetId);
      message = `@${account.username}: post beğenildi.`;
    } else if (action === 'repost') {
      await repostPost(env, account, tweetId);
      message = `@${account.username}: repost yapıldı.`;
    } else {
      if (!quoteText) return redirect('/?m=' + encodeURIComponent('Alıntı post için metin gerekli.'));
      const postId = await createPost(env, account, { text: quoteText, quote_tweet_id: tweetId });
      message = `@${account.username}: alıntı post yayınlandı (${postId}).`;
    }
    await logAudit(env, { action: `manual.${action}`, accountId: account.id, status: 200, target: tweetId, message });
    return redirect('/?m=' + encodeURIComponent(message));
  } catch (err) {
    await markAccountError(env, account.id, err.message);
    await logAudit(env, { action: `manual.${action}`, accountId: account.id, status: 500, target: tweetId, message: err.message });
    return redirect('/?m=' + encodeURIComponent(`Hata: ${err.message.slice(0, 220)}`));
  }
}

async function likePost(env, account, tweetId) {
  const token = await getValidAccessToken(env, account);
  const res = await fetch(`${X_API}/users/${encodeURIComponent(account.x_user_id)}/likes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tweet_id: tweetId })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`X like failed: ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function repostPost(env, account, tweetId) {
  const token = await getValidAccessToken(env, account);
  const res = await fetch(`${X_API}/users/${encodeURIComponent(account.x_user_id)}/retweets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tweet_id: tweetId })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`X repost failed: ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function removeAccount(request, env) {
  const form = await request.formData();
  const id = String(form.get('id') || '');
  if (!id) return redirect('/?m=' + encodeURIComponent('Hesap ID eksik.'));
  await env.DB.prepare(`UPDATE accounts SET active = 0, updated_at = ? WHERE id = ?`).bind(nowSeconds(), id).run();
  await logAudit(env, { action: 'account.remove', accountId: id, status: 200, target: id, message: 'Account deactivated' });
  return redirect('/?m=' + encodeURIComponent('Hesap panelden kaldırıldı.'));
}

async function cancelScheduled(request, env) {
  const form = await request.formData();
  const id = String(form.get('id') || '');
  if (!id) return redirect('/?m=' + encodeURIComponent('Plan ID eksik.'));
  await env.DB.prepare(`UPDATE scheduled_posts SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'`).bind(nowSeconds(), id).run();
  await logAudit(env, { action: 'post.cancel', status: 200, target: id, message: 'Scheduled post cancelled' });
  return redirect('/?m=' + encodeURIComponent('Planlı post iptal edildi.'));
}

async function processScheduledPosts(env) {
  validateEnv(env);
  const now = nowSeconds();
  const due = await env.DB.prepare(`
    SELECT sp.*, a.x_user_id, a.username, a.name, a.access_token_enc, a.refresh_token_enc, a.token_expires_at
    FROM scheduled_posts sp
    JOIN accounts a ON a.id = sp.account_id
    WHERE sp.status = 'queued' AND sp.scheduled_at <= ? AND a.active = 1
    ORDER BY sp.scheduled_at ASC
    LIMIT 20
  `).bind(now).all();

  for (const post of due.results || []) {
    await env.DB.prepare(`UPDATE scheduled_posts SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'`).bind(nowSeconds(), post.id).run();
    try {
      const resultPostId = await createPost(env, post, { text: post.content });
      await env.DB.prepare(`UPDATE scheduled_posts SET status = 'sent', result_post_id = ?, error = NULL, updated_at = ? WHERE id = ?`)
        .bind(resultPostId, nowSeconds(), post.id)
        .run();
      await logAudit(env, { action: 'post.scheduled.sent', accountId: post.account_id, status: 201, target: resultPostId, message: `Scheduled post ${post.id}` });
    } catch (err) {
      await env.DB.prepare(`UPDATE scheduled_posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
        .bind(err.message.slice(0, MAX_LOG_MESSAGE), nowSeconds(), post.id)
        .run();
      await markAccountError(env, post.account_id, err.message);
      await logAudit(env, { action: 'post.scheduled.failed', accountId: post.account_id, status: 500, target: post.id, message: err.message });
    }
  }
}

async function apiLogs(env) {
  const logs = await listAuditLogs(env, 100);
  return json({ data: logs });
}

async function listAccounts(env) {
  const res = await env.DB.prepare(`SELECT id, x_user_id, username, name, scope, token_expires_at, last_error, created_at, updated_at FROM accounts WHERE active = 1 ORDER BY username`).all();
  return res.results || [];
}

async function getAccount(env, id) {
  return env.DB.prepare(`SELECT * FROM accounts WHERE id = ? AND active = 1`).bind(id).first();
}

async function listScheduled(env) {
  const res = await env.DB.prepare(`
    SELECT sp.*, a.username
    FROM scheduled_posts sp
    LEFT JOIN accounts a ON a.id = sp.account_id
    ORDER BY sp.scheduled_at DESC
    LIMIT 50
  `).all();
  return res.results || [];
}

async function listAuditLogs(env, limit = 50) {
  const res = await env.DB.prepare(`SELECT * FROM audit_logs ORDER BY ts DESC LIMIT ?`).bind(limit).all();
  return res.results || [];
}

async function logAudit(env, { action, accountId = null, target = null, status = null, requestId = null, message = '', actor = 'admin' }) {
  try {
    await env.DB.prepare(`INSERT INTO audit_logs(ts, actor, action, account_id, target, status, request_id, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(nowSeconds(), actor, action, accountId, target, status, requestId, String(message || '').slice(0, MAX_LOG_MESSAGE))
      .run();
  } catch (err) {
    console.warn('audit failed', err);
  }
}

async function markAccountError(env, accountId, message) {
  await env.DB.prepare(`UPDATE accounts SET last_error = ?, updated_at = ? WHERE id = ?`)
    .bind(String(message || '').slice(0, 500), nowSeconds(), accountId)
    .run();
}

function extractTweetId(input) {
  const s = input.trim();
  if (/^\d{5,25}$/.test(s)) return s;
  const m = s.match(/(?:x\.com|twitter\.com)\/[^/]+\/status(?:es)?\/(\d{5,25})/i);
  return m ? m[1] : '';
}

function getStringArray(form, key) {
  return form.getAll(key).map((v) => String(v)).filter(Boolean);
}

function getBaseUrl(request, env) {
  if (env.BASE_URL) return String(env.BASE_URL).replace(/\/$/, '');
  const url = new URL(request.url);
  return url.origin;
}

function ensureSameOrigin(request, allowNoOrigin = false) {
  if (request.method.toUpperCase() === 'GET') return;
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  if (!origin && allowNoOrigin) return;
  if (origin && origin === url.origin) return;
  if (!origin && referer && referer.startsWith(url.origin + '/')) return;
  throw new Error('CSRF koruması: Origin/Referer uyuşmuyor.');
}

async function getSession(request, env) {
  const cookie = parseCookies(request.headers.get('Cookie') || '')[SESSION_COOKIE];
  if (!cookie) return null;
  try {
    const [payloadB64, sig] = cookie.split('.');
    if (!payloadB64 || !sig) return null;
    const expected = await hmac(payloadB64, env.SESSION_SECRET);
    if (!safeEqual(sig, expected)) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
    if (!payload.exp || payload.exp < nowSeconds()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function signSession(payload, secret) {
  const payloadB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64urlEncode(new Uint8Array(sig));
}

function setSessionCookie(request, value, maxAge) {
  const url = new URL(request.url);
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return { 'Set-Cookie': `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}` };
}

function clearSessionCookie(request) {
  const url = new URL(request.url);
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}` };
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function encryptString(env, plaintext) {
  const key = await aesKey(env.TOKEN_ENCRYPTION_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return base64urlEncode(combined);
}

async function decryptString(env, encoded) {
  const key = await aesKey(env.TOKEN_ENCRYPTION_KEY);
  const combined = base64urlDecode(encoded);
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

async function aesKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return base64urlEncode(new Uint8Array(digest));
}

function basicAuth(id, secret) {
  return 'Basic ' + btoa(`${id}:${secret}`);
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(18)));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function safeEqual(a, b) {
  const aa = String(a);
  const bb = String(b);
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return out === 0;
}

function base64urlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 303, headers: { Location: location, ...extraHeaders } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...securityHeaders()
    }
  });
}

function htmlPage(title, body, status = 200) {
  const html = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · X Safe Worker Manager</title>
  <style>
    :root { color-scheme: dark light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
    body { margin: 0; background: #0b1020; color: #e9eefc; }
    main { width: min(1180px, calc(100% - 32px)); margin: 32px auto 80px; }
    h1 { margin: 0 0 8px; font-size: 32px; }
    h2 { margin: 0 0 12px; font-size: 22px; }
    p { line-height: 1.55; }
    a { color: #b9cdfd; }
    .topbar, .split { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .card { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 18px; padding: 22px; margin: 18px 0; box-shadow: 0 20px 60px rgba(0,0,0,.22); }
    .narrow { max-width: 480px; margin: 10vh auto; }
    .muted { color: #aab4d4; }
    .stack { display: grid; gap: 14px; }
    label { display: grid; gap: 7px; font-weight: 650; }
    input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid rgba(255,255,255,.16); border-radius: 12px; padding: 12px 14px; font: inherit; background: rgba(0,0,0,.25); color: inherit; }
    textarea { resize: vertical; }
    button, .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 12px; padding: 12px 16px; font-weight: 800; text-decoration: none; background: #7aa2ff; color: #09101f; cursor: pointer; }
    .secondary { background: rgba(255,255,255,.12); color: #e9eefc; border: 1px solid rgba(255,255,255,.16); }
    .dangerBtn { background: rgba(255,80,80,.12); color: #ffc4c4; border-color: rgba(255,80,80,.32); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .alert { border-radius: 14px; padding: 14px 16px; margin: 16px 0; border: 1px solid transparent; }
    .ok { background: rgba(80, 210, 140, .12); border-color: rgba(80, 210, 140, .26); color: #c9ffdf; }
    .warn { background: rgba(255, 194, 87, .12); border-color: rgba(255, 194, 87, .28); color: #ffe7b2; }
    .danger { background: rgba(255, 88, 88, .14); border-color: rgba(255, 88, 88, .28); color: #ffd1d1; }
    .dangerText { color: #ffb2b2; }
    .okText { color: #9ff2bf; }
    .tableWrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid rgba(255,255,255,.1); vertical-align: top; }
    th { color: #b9c5e6; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; }
    code, .badge { background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 2px 6px; }
    .accountBox { border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 14px; display: grid; gap: 10px; }
    .rowLabel { display: flex; align-items: flex-start; gap: 10px; font-weight: 600; }
    .rowLabel input[type="checkbox"] { width: auto; margin-top: 4px; }
    .small { font-size: 13px; color: #c7d1ee; }
    @media (max-width: 720px) { .topbar, .split { align-items: stretch; flex-direction: column; } main { width: min(100% - 20px, 1180px); margin-top: 18px; } }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders() } });
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://x.com; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
