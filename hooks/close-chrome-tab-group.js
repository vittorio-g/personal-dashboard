#!/usr/bin/env node
// Stop hook: a session that used Claude in Chrome must not end its turn with its tab group
// still open. A group left open stays in Chrome's bookmarks bar as a saved chip, one per
// session, and they pile up.
//
// The hook cannot talk to Chrome, so it reads the session transcript: the answers of the
// extension's own tools say whether this session still has a tab group. If it does, the stop
// is blocked ONCE with an instruction to close the tabs; Claude closes them and then stops.
//
// Input (stdin): { session_id, transcript_path, stop_hook_active, ... }
// Output: nothing (allow the stop) or {"decision":"block","reason":"..."}.
// Any error allows the stop: a cleanup helper must never trap a session.

const fs = require('fs');

const PREFIX = 'mcp__claude-in-chrome__';
// In a result of one of the extension's tools: the session has a group with tabs in it...
const OPEN = ['tabGroupId', 'Created new tab. Tab ID', 'Executed on tabId', '• tabId'];
// ...or it has none.
const CLOSED = [
  'Group is now empty (auto-removed)',
  'No tab group exists for this session',
  'tab group no longer exists',
  'has no tab group of its own',
];

/** 'open' | 'closed' | null, from the last thing the extension said in this transcript. */
function groupState(text) {
  const chromeCalls = new Set();
  let state = null;
  for (const line of text.split('\n')) {
    const isUse = line.includes(PREFIX) && line.includes('"tool_use"');
    const isResult = line.includes('"tool_result"') &&
      (line.includes('tabId') || line.includes('tab group') || line.includes('Group is now empty') || line.includes('Tab ID'));
    if (!isUse && !isResult) continue;
    let j;
    try { j = JSON.parse(line); } catch (e) { continue; }
    const content = j && j.message && j.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'tool_use' && String(b.name || '').startsWith(PREFIX)) chromeCalls.add(b.id);
      if (b.type !== 'tool_result' || !chromeCalls.has(b.tool_use_id)) continue;
      const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      // Within one answer the last marker wins: a batch can open a tab and close it again.
      let o = -1, c = -1;
      for (const m of OPEN) o = Math.max(o, t.lastIndexOf(m));
      for (const m of CLOSED) c = Math.max(c, t.lastIndexOf(m));
      if (o < 0 && c < 0) continue;
      state = c > o ? 'closed' : 'open';
    }
  }
  return state;
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (e) { return; }
  if (input.stop_hook_active) return;            // already continuing because of a stop hook: never loop
  const p = input.transcript_path;
  if (!p || !fs.existsSync(p)) return;
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
  if (!text.includes(PREFIX)) return;            // this session never used Chrome
  if (groupState(text) !== 'open') return;

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason:
      'Prima di fermarti: questa sessione ha ancora un gruppo di schede aperto in Chrome. ' +
      'Chiama mcp__claude-in-chrome__tabs_context_mcp (senza createIfEmpty) e chiudi con ' +
      'mcp__claude-in-chrome__tabs_close_mcp ogni scheda che elenca, poi richiama tabs_context_mcp ' +
      'per controllare che il gruppo non esista più. Un gruppo lasciato aperto resta nella barra dei ' +
      'preferiti di Chrome come etichetta salvata. Lascialo aperto SOLO se l\'utente ha chiesto ' +
      'esplicitamente di tenere quelle schede, o se gli hai appena fatto una domanda la cui risposta ' +
      'prosegue in quella stessa pagina: in quel caso dillo in una riga. Se la chiusura viene ' +
      'rifiutata, scrivi che il gruppo è rimasto aperto. Poi concludi normalmente.',
  }));
}

if (require.main === module) { try { main(); } catch (e) { /* allow the stop */ } }
module.exports = { groupState };
