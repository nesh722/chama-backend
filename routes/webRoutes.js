const express = require('express');
const db = require('../config/db');

const router = express.Router();

const APP_PACKAGE = 'com.victormunene.chamaapp';

// Group names and descriptions are typed by users, so they're escaped before going into HTML
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: #f1f5f9; color: #0f172a; }
  main { width: 100%; max-width: 380px; margin: 16px; padding: 28px 24px; border-radius: 16px;
         background: #fff; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 6px; color: #64748b; }
  .group { font-size: 24px; font-weight: 700; margin: 0 0 4px; }
  .meta { margin: 0 0 12px; color: #2563eb; font-weight: 600; }
  .desc { margin: 0 0 16px; color: #475569; }
  .btn { display: block; padding: 14px; border-radius: 10px; background: #2563eb; color: #fff;
         text-decoration: none; font-weight: 600; font-size: 16px; margin-top: 16px; }
  .hint { font-size: 13px; color: #64748b; margin: 12px 0 0; }
  .code { margin-top: 20px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; }
  code { display: block; margin-top: 6px; padding: 8px; border-radius: 8px; background: #f1f5f9;
         color: #0f172a; word-break: break-all; user-select: all; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f172a; color: #f8fafc; }
    main { background: #1e293b; box-shadow: none; }
    .desc { color: #cbd5e1; } .code { border-color: #334155; }
    code { background: #0f172a; color: #f8fafc; }
  }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

router.get('/join/:token', async (req, res) => {
  const { token } = req.params;

  // Invite tokens are 32 hex characters. Anything else is rejected before it touches the database or the page.
  if (!/^[a-f0-9]{32}$/.test(token)) {
    return res.status(404).type('html').send(page('Invite not found', '<h1>Invite not found</h1><p>This invite link is not valid.</p>'));
  }

  try {
    const [rows] = await db.query(
      'SELECT name, description, contribution_amount, contribution_frequency FROM groups_table WHERE invite_token = ?',
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).type('html').send(
        page('Invite expired', "<h1>Invite expired</h1><p>This invite link is no longer valid. Ask the group's treasurer or chair for a new one.</p>")
      );
    }

    const g = rows[0];
    const amount = Number(g.contribution_amount).toLocaleString('en-KE');
    const fullLink = `${req.protocol}://${req.get('host')}/join/${token}`;

    const body = `
      <h1>You're invited to join</h1>
      <p class="group">${esc(g.name)}</p>
      <p class="meta">KES ${esc(amount)} · ${esc(g.contribution_frequency)}</p>
      ${g.description ? `<p class="desc">${esc(g.description)}</p>` : ''}
      <a id="open" class="btn" href="mobile://join/${token}">Open in Chama App</a>
      <p class="hint">If nothing happens, the app may not be installed on this phone.</p>
      <div class="code">Or paste this in the app under Join Group:<code>${esc(fullLink)}</code></div>
      <script>
        // Chrome on Android opens apps reliably through an intent link, but only after a tap
        if (/android/i.test(navigator.userAgent)) {
          document.getElementById('open').href =
            'intent://join/${token}#Intent;scheme=mobile;package=${APP_PACKAGE};end';
        }
      </script>`;

    res.type('html').send(page(`Join ${g.name}`, body));
  } catch (err) {
    res.status(500).type('html').send(page('Error', '<h1>Something went wrong</h1><p>Please try again.</p>'));
  }
});

module.exports = router;