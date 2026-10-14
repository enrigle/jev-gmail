// main.js glue run in node against fake Apps Script services.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const b64 = text => Buffer.from(text, 'utf8').toString('base64url');
const GOOD = {
  folder: { choice: 'Jobs', confidence: 0.95 },
  needs_reply: { noul: 0.8 },
  priority: { score: 1.7 },
  job_stage: { choice: 'Offer', confidence: 0.9 },
};

/** Fresh sandbox: rules.js + main.js with fake services. `opts` overrides defaults. */
function sandbox(opts = {}) {
  const s = { modified: [], created: [], logs: [] };
  const messages = opts.messages || { m1: { mimeType: 'text/plain', body: { data: b64('Año señal') } } };
  const ctx = {
    console: { log: x => s.logs.push(String(x)) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'k' }) },
    Utilities: {
      base64DecodeWebSafe: d => {
        if (typeof d !== 'string') throw new Error('Invalid argument: base64');
        return [...Buffer.from(d, 'base64url')].map(b => (b > 127 ? b - 256 : b)); // Java signed bytes
      },
      newBlob: bytes => ({
        getDataAsString: () => Buffer.from(Array.from(bytes, b => b & 255)).toString('utf8'),
      }),
    },
    Gmail: { Users: {
      Messages: {
        list: () => ({ messages: Object.keys(messages).map(id => ({ id })) }),
        get: (me, id) => {
          if (messages[id] === 'throw') throw new Error('Gmail get failed');
          return { snippet: 's', payload: messages[id] };
        },
        modify: (body, me, id) => s.modified.push([id, JSON.parse(JSON.stringify(body.addLabelIds))]),
      },
      Labels: {
        list: () => ({ labels: opts.labels || [{ name: 'Jobs', id: 'L_jobs' }] }),
        create: body => { s.created.push(body.name); return { id: 'L_' + body.name }; },
      },
    } },
    UrlFetchApp: { fetch: () => ({
      getResponseCode: () => opts.code || 200,
      getContentText: () => opts.text || JSON.stringify({ answers: opts.answers || GOOD }),
    }) },
  };
  vm.createContext(ctx);
  const dir = __dirname;
  vm.runInContext(
    fs.readFileSync(path.join(dir, 'rules.js'), 'utf8') + '\n' + fs.readFileSync(path.join(dir, 'main.js'), 'utf8'),
    ctx,
  );
  s.run = () => vm.runInContext('run()', ctx);
  return s;
}

test('labels folder, stage, star, important; creates missing label; logs ids only', () => {
  const s = sandbox();
  s.run();
  assert.deepEqual(s.modified, [['m1', ['L_jobs', 'L_Jobs-Offer', 'STARRED', 'IMPORTANT']]]);
  assert.deepEqual(s.created, ['Jobs-Offer']);
  assert.ok(!s.logs.join('\n').includes('Año'));
});

test('a 200 answer that cannot be used goes to Review (no endless retries)', () => {
  const s = sandbox({ answers: { folder: { choice: 'Jobs' } } });
  s.run();
  assert.deepEqual(s.modified, [['m1', ['L_Review']]]);
});

test('429 skips the email without labels', () => {
  const s = sandbox({ code: 429 });
  s.run();
  assert.deepEqual(s.modified, []);
});

test('one failing email does not stop the others', () => {
  const s = sandbox({
    messages: { bad: 'throw', m2: { mimeType: 'text/plain', body: { data: b64('hola') } } },
  });
  s.run();
  assert.deepEqual(s.modified.map(m => m[0]), ['m2']);
});

test('existing label with different case is reused, not created again', () => {
  const s = sandbox({ labels: [{ name: 'jobs', id: 'L_lower' }, { name: 'Jobs-Offer', id: 'L_o' }] });
  s.run();
  assert.deepEqual(s.created, []);
  assert.deepEqual(s.modified[0][1].slice(0, 2), ['L_lower', 'L_o']);
});

test('body bytes given as a non-Array array-like still decode', () => {
  const bytes = Int8Array.from(Buffer.from('Año', 'utf8'));
  const s = sandbox({ messages: { m1: { mimeType: 'text/plain', body: { data: bytes } } } });
  s.run();
  assert.equal(s.modified.length, 1);
});

test('hard failure stops the run and keeps response text out of the error', () => {
  const s = sandbox({ code: 400, text: '{"error":"bad request","echo":"Entrevista Año"}' });
  assert.throws(s.run, err => err.message === 'OpenRouter 400');
});
