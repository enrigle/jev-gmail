const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('./rules.js');
const pythonQuestions = require('./test/python-questions.json');

const utf8 = data => Buffer.from(data, 'base64url').toString('utf8');
const b64 = text => Buffer.from(text, 'utf8').toString('base64url');

test('questions match what the Python sorter sends', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(r.QUESTIONS)), pythonQuestions);
});

test('query excludes every folder label and Review', () => {
  assert.equal(
    r.QUERY,
    'in:inbox -label:Work -label:Jobs -label:Finance -label:Tax -label:House -label:Shopping ' +
      '-label:Accounts -label:Kids -label:Courses -label:Language -label:Newsletters ' +
      '-label:Personal -label:Other -label:Review',
  );
});

test('decide boundaries are inclusive', () => {
  assert.deepEqual(r.decide('Work', 0.99, 0.99, 2.0, '', 0), {
    folder: 'Work', needsReply: true, urgent: true, stage: '',
  });
  assert.deepEqual(r.decide('Jobs', r.FOLDER_MIN, r.REPLY_MIN, r.URGENT, '', 0), {
    folder: 'Jobs', needsReply: true, urgent: true, stage: '',
  });
  assert.deepEqual(r.decide('Jobs', r.FOLDER_MIN - 0.01, r.REPLY_MIN - 0.01, r.URGENT - 0.01, '', 0), {
    folder: 'Review', needsReply: false, urgent: false, stage: '',
  });
});

test('unknown folders, prototype keys and NaN go to Review', () => {
  for (const name of ['SPAM', '', 'toString', 'constructor', '__proto__']) {
    assert.equal(r.decide(name, 1, 0, 0, '', 0).folder, 'Review', name);
  }
  assert.deepEqual(r.decide('Work', NaN, NaN, NaN, '', 0), {
    folder: 'Review', needsReply: false, urgent: false, stage: '',
  });
});

test('job stage only for Jobs, known stage, confident', () => {
  assert.equal(r.jobStage('Jobs', 'Interview', r.FOLDER_MIN), 'Jobs-Interview');
  assert.equal(r.jobStage('Jobs', 'Interview', r.FOLDER_MIN - 0.01), '');
  assert.equal(r.jobStage('Work', 'Interview', 1), '');
  assert.equal(r.jobStage('Jobs', 'toString', 1), '');
  assert.equal(r.jobStage('Jobs', 'Offer', NaN), '');
  assert.equal(r.decide('Jobs', 0.9, 0, 0, 'Offer', 0.9).stage, 'Jobs-Offer');
  assert.equal(r.decide('Jobs', 0.1, 0, 0, 'Offer', 0.9).stage, '');
});

test('parseAnswers reads all four answers', () => {
  const answers = {
    folder: { choice: 'Jobs', confidence: 0.9 },
    needs_reply: { noul: 0.7 },
    priority: { score: 1.6 },
    job_stage: { choice: 'Interview', confidence: 0.8 },
  };
  assert.deepEqual(r.parseAnswers(answers), {
    folder: 'Jobs', confidence: 0.9, replyP: 0.7, priority: 1.6, stage: 'Interview', stageConf: 0.8,
  });
});

test('parseAnswers returns null on missing fields or wrong types', () => {
  assert.equal(r.parseAnswers(null), null);
  assert.equal(r.parseAnswers({}), null);
  assert.equal(r.parseAnswers({ folder: { choice: 'Jobs', confidence: 0.9 } }), null);
  assert.equal(
    r.parseAnswers({
      folder: { choice: 'Jobs', confidence: '0.9' },
      needs_reply: { noul: 0.7 },
      priority: { score: 1.6 },
      job_stage: { choice: 'Interview', confidence: 0.8 },
    }),
    null,
  );
});

test('labelsFor lists folder, stage and system labels', () => {
  assert.deepEqual(r.labelsFor({ folder: 'Jobs', needsReply: true, urgent: true, stage: 'Jobs-Offer' }), {
    names: ['Jobs', 'Jobs-Offer'], system: ['STARRED', 'IMPORTANT'],
  });
  assert.deepEqual(r.labelsFor({ folder: 'Review', needsReply: false, urgent: false, stage: '' }), {
    names: ['Review'], system: [],
  });
});

test('jevStatus: ok, retryable skip, hard fail', () => {
  assert.equal(r.jevStatus(200), 'ok');
  for (const code of [429, 500, 502, 520]) assert.equal(r.jevStatus(code), 'skip', String(code));
  for (const code of [400, 401, 402, 403, 404]) assert.equal(r.jevStatus(code), 'fail', String(code));
});

test('toState: nested text/plain wins over HTML, UTF-8 decoded', () => {
  const msg = {
    snippet: 'snip',
    payload: {
      headers: [{ name: 'Subject', value: 'Hola' }, { name: 'From', value: 'a@b.es' }],
      parts: [
        { mimeType: 'text/html', body: { data: b64('<p>html</p>') } },
        { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('Año señal') } }] },
      ],
    },
  };
  assert.deepEqual(r.toState(msg, utf8), { from: 'a@b.es', subject: 'Hola', body: 'Año señal' });
});

test('toState: HTML-only falls back to snippet; body capped; empty payload', () => {
  const htmlOnly = { snippet: 'snip', payload: { mimeType: 'text/html', body: { data: b64('<p>x</p>') } } };
  assert.equal(r.toState(htmlOnly, utf8).body, 'snip');
  const long = { payload: { mimeType: 'text/plain', body: { data: b64('x'.repeat(5000)) } } };
  assert.equal(r.toState(long, utf8).body.length, r.MAX_BODY);
  assert.equal(r.toState(long, utf8, 0).body, '');
  assert.equal(r.toState(long, utf8, -5).body, '');
  assert.deepEqual(r.toState({ payload: {} }, utf8), { from: '', subject: '', body: '' });
});
