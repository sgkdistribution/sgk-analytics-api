// ===========================================================================
// ADD A COMPANY TO THE DASHBOARDS — the work behind deploy/add-client.sh.
//
//   sudo bash /opt/sgk-analytics-api/deploy/add-client.sh Abode
//
// 1. Reads /etc/sgk-analytics.env the way systemd does (the SQL password can
//    hold characters a shell would mangle, so the shell never touches it).
// 2. Asks for the company's Cognito group — the one thing that ties a login to
//    a company — and checks it really belongs to a company of that name.
// 3. Finds the company's client name(s) in the delivery system itself, and
//    refuses any name another company already owns.
// 4. Shows exactly what it will save and waits for a yes.
// 5. Keeps a dated copy of the settings file, writes the new CLIENT_MAP line and
//    touches no other line.
// 6. PROVES THE LOCKDOWN before restarting: the company's own group sees its
//    dashboard; a second company with the same name, and an unrelated company,
//    do not. Any failure puts the old file back and stops.
// 7. Restarts the service and checks it answers.
// ===========================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENVF = process.env.SGK_ENV_FILE || '/etc/sgk-analytics.env';
const SERVICE = 'sgk-analytics-api';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const slugOf = (name) => norm(name).slice(0, 24);
const say = (s = '') => stdout.write(`${s}\n`);
const stop = (msg) => { say(`\n✖ ${msg}`); process.exit(1); };

// ── the settings file, read the way systemd reads it ─────────────────────────
// KEY=value per line; '#' or ';' at the start is a comment; a value starting
// with ' or " is quoted; an unquoted value runs to the end of the line, with a
// backslash taking the next character literally. A later line wins.
function parseEnv(text) {
  const lines = text.split('\n');
  const vars = new Map();
  lines.forEach((line, i) => {
    const t = line.replace(/\r$/, '');
    if (!t.trim() || /^\s*[#;]/.test(t)) return;
    const eq = t.indexOf('=');
    if (eq < 1) return;
    const key = t.slice(0, eq).trim();
    let raw = t.slice(eq + 1).replace(/^\s+/, '');
    let value = '';
    if (raw.startsWith("'")) {
      const end = raw.indexOf("'", 1);
      value = end === -1 ? raw.slice(1) : raw.slice(1, end);
    } else if (raw.startsWith('"')) {
      for (let j = 1; j < raw.length; j++) {
        const c = raw[j];
        if (c === '\\' && j + 1 < raw.length) { value += raw[++j]; continue; }
        if (c === '"') break;
        value += c;
      }
    } else {
      raw = raw.replace(/\s+$/, '');
      for (let j = 0; j < raw.length; j++) {
        const c = raw[j];
        if (c === '\\' && j + 1 < raw.length) { value += raw[++j]; continue; }
        value += c;
      }
    }
    vars.set(key, { value, line: i });
  });
  return { lines, vars };
}

async function main() {
  if (!fs.existsSync(ENVF)) stop(`${ENVF} is missing.`);
  const original = fs.readFileSync(ENVF, 'utf8');
  const { lines, vars } = parseEnv(original);
  for (const [k, v] of vars) process.env[k] = v.value;

  let map = [];
  try {
    map = JSON.parse(vars.get('CLIENT_MAP')?.value || '[]');
    if (!Array.isArray(map)) throw new Error('not a list');
  } catch (e) {
    stop(`CLIENT_MAP in ${ENVF} is not valid JSON (${e.message}). Nothing was changed.`);
  }

  say('\n=== COMPANIES WITH A DASHBOARD NOW ===');
  if (!map.length) say('  (none)');
  for (const c of map) {
    const keys = Array.isArray(c.sqlKey) ? c.sqlKey.join(' + ') : c.sqlKey;
    // A short handle ('roseland') is matched by NAME, so a second company with
    // the same name — a testing copy — would see these figures too.
    const pinned = /^[a-z0-9]{1,24}-[a-z0-9]{10,}$/.test(String(c.companyId));
    say(`  • ${c.name || c.companyId}   [${c.companyId}]   ← ${keys}${pinned ? '' : '   ⚠ matched by name — run this again for it to pin it to its own group'}`);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = async (q) => (await rl.question(q)).trim();

  // 1. Which company.
  let name = process.argv.slice(2).join(' ').trim();
  if (!name) name = await ask('\nCompany name, exactly as the portal shows it: ');
  if (!name) stop('No company name given. Nothing was changed.');
  const slug = slugOf(name);

  // 2. Its Cognito group — the lockdown key.
  say(`\nIn the AWS console: Cognito → User pools → the pool with the users in it → Groups.`);
  say(`Find the group that starts with  company_${slug}-  and copy its name.`);
  let companyId = '';
  for (let tries = 0; tries < 3 && !companyId; tries++) {
    const g = (await ask(`Paste ${name}'s group here and press Enter: `)).replace(/^company_/, '');
    if (!/^[a-z0-9]{1,24}-[a-z0-9]{10,}$/.test(g)) { say('  That is not a company group (it looks like company_abode-mtx3k9q2b1c4ze). Try again.'); continue; }
    if (g.split('-')[0] !== slug) {
      say(`  That group belongs to a company called "${g.split('-')[0]}", not "${name}". Try again.`);
      continue;
    }
    companyId = g;
  }
  if (!companyId) stop('No valid group given. Nothing was changed.');

  // 3. Its client name(s) in the delivery system.
  say('\nReading the client names in the delivery system…');
  let partners = [];
  try {
    const Q = await import(path.join(APP, 'queries.js'));
    partners = await Q.partnerNames();
  } catch (e) {
    stop(`Could not read the delivery system: ${e?.message || e}. Nothing was changed.`);
  }
  const ownedBy = new Map();
  for (const c of map) {
    if (c.companyId === companyId || norm(c.name) === norm(name)) continue;       // the entry being replaced
    for (const k of (Array.isArray(c.sqlKey) ? c.sqlKey : [c.sqlKey])) ownedBy.set(String(k), c.name || c.companyId);
  }
  const word = norm(name);
  let found = partners.filter((p) => norm(p.partnerName).includes(word));
  let chosen = [];
  // ALREADY ON: keep its client names exactly as they are unless told otherwise —
  // pinning a company to its group must never change which orders it counts.
  const existing = map.find((c) => c.companyId === companyId) || map.find((c) => norm(c.name) === norm(name));
  const kept = existing ? (Array.isArray(existing.sqlKey) ? existing.sqlKey : [existing.sqlKey]).map(String) : [];
  if (kept.length) {
    say(`\n${name} already has a dashboard, counting: ${kept.join(' + ')}`);
    const k = (await ask('Keep exactly these? (y = keep / s = search again / n = stop): ')).toLowerCase();
    if (k === 'n' || k === '') stop('Stopped. Nothing was changed.');
    if (k === 'y') { chosen = kept; found = []; }
  }
  if (chosen.length) {
    // kept as they were — nothing to choose
  } else if (found.length) {
    say(`\nClient names in the delivery system that match "${name}":`);
    found.forEach((p, i) => {
      const owner = ownedBy.get(p.partnerName);
      say(`  ${i + 1}. ${p.partnerName}   (${Number(p.orders).toLocaleString('en-GB')} orders)${owner ? `   ⚠ already belongs to ${owner}` : ''}`);
    });
    const a = (await ask('\nUse them all? Type y for all, the numbers to keep (e.g. 1,3), or n to stop: ')).toLowerCase();
    if (a === 'n' || a === '') stop('Stopped. Nothing was changed.');
    chosen = a === 'y' ? found.map((p) => p.partnerName)
      : a.split(/[\s,]+/).map(Number).filter((n) => n >= 1 && n <= found.length).map((n) => found[n - 1].partnerName);
  } else {
    say(`\nNothing in the delivery system matches "${name}". The biggest client names there are:`);
    partners.slice(0, 40).forEach((p) => say(`  • ${p.partnerName}   (${Number(p.orders).toLocaleString('en-GB')} orders)`));
    const typed = await ask(`\nType ${name}'s client name(s) exactly, separated by commas — or press Enter to stop: `);
    if (!typed) stop('Stopped. Nothing was changed.');
    const exact = new Set(partners.map((p) => p.partnerName));
    chosen = typed.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = chosen.filter((k) => !exact.has(k));
    if (unknown.length) stop(`Not in the delivery system: ${unknown.join(', ')}. Nothing was changed.`);
  }
  chosen = [...new Set(chosen)];
  if (!chosen.length) stop('No client names chosen. Nothing was changed.');
  // A client name can belong to ONE company — two owners means two companies see the same orders.
  const taken = chosen.filter((k) => ownedBy.has(k));
  if (taken.length) stop(`${taken.map((k) => `"${k}" already belongs to ${ownedBy.get(k)}`).join('; ')}. Nothing was changed.`);

  // 4. What will be saved.
  const old = map.find((c) => c.companyId === companyId) || map.find((c) => norm(c.name) === norm(name));
  const entry = {
    companyId,
    name,
    sqlKey: chosen.length === 1 ? chosen[0] : chosen,
    // Matched by its Cognito group, so no email domain is needed — and none is
    // guessed: a wrong domain would hand these figures to strangers.
    domains: old?.domains || [],
    emails: old?.emails || [],
  };
  const next = old ? map.map((c) => (c === old ? entry : c)) : [...map, entry];
  say(`\n${old ? 'REPLACING' : 'ADDING'}:`);
  if (old) say(`  was: ${JSON.stringify(old)}`);
  say(`  now: ${JSON.stringify(entry)}`);
  const go = (await ask('\nSave this and restart the dashboards? (y/n): ')).toLowerCase();
  rl.close();
  if (go !== 'y') stop('Stopped. Nothing was changed.');

  // 5. Write it — CLIENT_MAP only, every other line exactly as it was.
  const json = JSON.stringify(next);
  if (json.includes('\\') || json.includes('\n')) stop('A name contains a character the settings file cannot hold. Nothing was changed.');
  const cm = vars.get('CLIENT_MAP');
  const out = [...lines];
  if (cm) out[cm.line] = `CLIENT_MAP=${json}`;
  else out.splice(out.length && out[out.length - 1] === '' ? out.length - 1 : out.length, 0, `CLIENT_MAP=${json}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const backup = `${ENVF}.bak-${stamp}`;
  const st = fs.statSync(ENVF);
  fs.copyFileSync(ENVF, backup);
  fs.chmodSync(backup, 0o600);
  const tmp = `${ENVF}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out.join('\n'), { mode: st.mode & 0o777 });
  fs.chownSync(tmp, st.uid, st.gid);
  fs.renameSync(tmp, ENVF);
  say(`\nSaved. The old file is kept as ${backup}`);
  const putBack = (why) => {
    fs.copyFileSync(backup, ENVF);
    fs.chmodSync(ENVF, st.mode & 0o777);
    fs.chownSync(ENVF, st.uid, st.gid);
    stop(`${why}\nThe old settings file has been put back. The dashboards were NOT restarted.`);
  };

  // 6. Prove the lockdown with the code that will actually run.
  say('\n=== LOCKDOWN CHECK ===');
  const probe = `
    const { resolveCompany } = await import(${JSON.stringify(path.join(APP, 'clients.js'))});
    const who = (groups) => { try { return resolveCompany({ email: 'lockdown-check@example.invalid', groups }).company?.name || null; } catch { return null; } };
    console.log(JSON.stringify({
      own: who(['company_' + ${JSON.stringify(companyId)}]),
      twin: who(['company_' + ${JSON.stringify(slug)} + '-zzzzzzzzzzzzzz']),
      stranger: who(['company_somebodyelse-zzzzzzzzzzzzzz']),
    }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: APP, encoding: 'utf8', env: { ...process.env, CLIENT_MAP: json },
  });
  let r = null;
  try { r = JSON.parse(String(run.stdout).trim().split('\n').pop()); } catch { /* reported below */ }
  if (!r) putBack(`The check could not run: ${String(run.stderr || run.stdout).slice(0, 400)}`);
  const pass = (ok, text) => { say(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`); return ok; };
  const a = pass(r.own === name, `${name}'s own login sees ${name}'s dashboard`);
  const b = pass(r.twin !== name, `another company also called "${name}" sees nothing of it`);
  const c = pass(r.stranger !== name, 'an unrelated company sees nothing of it');
  if (!(a && b && c)) {
    putBack(r.twin === name
      ? 'The code on this box is out of date — it still matches companies by name. Update it first, then run this again.'
      : 'The lockdown check failed.');
  }

  // 7. Restart and make sure it answers.
  say('\nRestarting the dashboards…');
  const restart = spawnSync('systemctl', ['restart', SERVICE], { encoding: 'utf8' });
  if (restart.status !== 0) stop(`The restart failed: ${restart.stderr}`);
  const port = process.env.PORT || 8080;
  let health = null;
  for (let i = 0; i < 20 && !health; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    try {
      const h = await fetch(`http://127.0.0.1:${port}/health`);
      if (h.ok) health = await h.json();
    } catch { /* still starting */ }
  }
  if (!health) stop(`The service did not answer after the restart. Run:  sudo journalctl -u ${SERVICE} -n 50`);
  say(`  The service is running · database: ${health.db} · companies with a dashboard: ${health.clients}`);
  say(`\n✔ DONE — ${name}'s dashboard is live. ${name} → Dashboard in the portal shows it now.`);
  process.exit(0);
}

main().catch((e) => stop(e?.stack || e?.message || String(e)));
