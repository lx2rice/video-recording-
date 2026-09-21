// Focused controller checks. No browser or paid AI calls.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const nodes = new Map();
const getNode = sel => {
  if (!nodes.has(sel)) nodes.set(sel, {value:'', textContent:'', hidden:false, classList:{toggle(){}}, setAttribute(){}});
  return nodes.get(sel);
};
const saved = new Map();
const context = vm.createContext({
  document: {querySelector:getNode,querySelectorAll:()=>[]},
  navigator:{userAgent:'test',platform:'test',maxTouchPoints:0},
  window:{matchMedia:()=>({matches:false})},
  store:{loadSettings:()=>({}),putSession:async s => {saved.set(s.id, structuredClone(s));}},
  Recorder:class {}, missingCredentials:s=>s.openaiKey ? null : 'missing',
  streamChat:async()=> 'A concise AI summary.',
  setTimeout:()=>0,clearTimeout(){},confirm:()=>true,console,
});
const source = fs.readFileSync('js/app.js','utf8').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'');
vm.runInContext(source,context);
(async()=>{
  await vm.runInContext(`state.current={id:'a',notes:'',transcript:{text:'Solar power needs panels. Batteries store energy. Stored energy helps after sunset.'}}; makeNote()`,context);
  assert.equal(saved.get('a').noteKind,'Extracted highlights');
  assert(saved.get('a').transcript.text.includes('Solar power'));
  assert(getNode('#note-editor').value.includes('Batteries'));
  await vm.runInContext(`state.settings.openaiKey='test-only'; makeNote()`,context);
  assert.equal(saved.get('a').notes,'A concise AI summary.');
  assert.equal(saved.get('a').noteKind,'AI summary');
  context.streamChat=async()=>{throw new Error('Provider unavailable')};
  await vm.runInContext('makeNote()',context);
  assert.equal(saved.get('a').notes,'A concise AI summary.');
  assert.equal(vm.runInContext('state.busy',context),false);
  assert(getNode('#note-status').textContent.includes('Provider unavailable'));
  getNode('#note-editor').value='Edited note';
  await vm.runInContext('saveNote()',context);
  assert.equal(saved.get('a').notes,'Edited note');
  const highlights=vm.runInContext(`extractHighlights('太阳能可以发电。电池可以储存电能。')`,context);
  assert(highlights.includes('电池'));
  console.log('PASS: local highlights, AI summary, error retention, unlock, note persistence, Chinese input.');
})().catch(err=>{console.error(err);process.exitCode=1});
