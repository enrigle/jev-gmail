/**
 * Apps Script entry points for the Gmail Jev sorter. Thin glue over rules.js:
 * Gmail advanced service (gmail.modify), UrlFetchApp to Jev, a lock, a 5-minute trigger.
 * Checked manually (README "Apps Script"); the logic it calls is unit-tested.
 */

/** Trigger entry: sort up to MAX_PER_RUN unsorted inbox emails. */
function run() {
  sortBatch_(MAX_PER_RUN);
}

/** Manual test from the editor: sort exactly one email. */
function runOnce() {
  sortBatch_(1);
}

/** Replace any existing `run` trigger with one every 5 minutes. Run once from the editor. */
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'run')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('run').timeBased().everyMinutes(5).create();
}

function sortBatch_(limit) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('previous run still active, skipping');
    return;
  }
  try {
    const key = PropertiesService.getScriptProperties().getProperty('OPENROUTER_API_KEY');
    if (!key) throw new Error('Set OPENROUTER_API_KEY in Project Settings > Script Properties');
    const ids = (Gmail.Users.Messages.list('me', { q: QUERY, maxResults: limit }).messages || []).map(
      m => m.id,
    );
    console.log(ids.length + ' emails to sort');
    const labelId = labelCache_();
    for (const id of ids) {
      const msg = Gmail.Users.Messages.get('me', id, { format: 'full' });
      const p = parseAnswers(askJev_(key, toState(msg, decode_)));
      if (!p) {
        console.log('skip ' + id + ': no usable answer, retried next run');
        continue;
      }
      const d = decide(p.folder, p.confidence, p.replyP, p.priority, p.stage, p.stageConf);
      const l = labelsFor(d);
      const add = l.names.map(labelId).concat(l.system);
      Gmail.Users.Messages.modify({ addLabelIds: add, removeLabelIds: [] }, 'me', id);
      console.log(
        '[' + d.folder + '] ' + (d.stage || '-') + ' reply=' + d.needsReply +
          ' urgent=' + d.urgent + ' | ' + id,
      );
    }
  } finally {
    lock.releaseLock();
  }
}

/** POST the questions; return `answers`, or null to skip this email (retried next run). */
function askJev_(key, state) {
  let resp;
  try {
    resp = UrlFetchApp.fetch(JEV_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key },
      payload: JSON.stringify({ model: JEV_MODEL, state: state, questions: QUESTIONS }),
      muteHttpExceptions: true,
    });
  } catch (e) {
    console.log('network error, retry next run: ' + e);
    return null;
  }
  const code = resp.getResponseCode();
  const status = jevStatus(code);
  if (status === 'skip') {
    console.log('OpenRouter ' + code + ', retry next run');
    return null;
  }
  if (status === 'fail') {
    throw new Error('OpenRouter ' + code + ': ' + resp.getContentText().slice(0, 200));
  }
  try {
    return JSON.parse(resp.getContentText()).answers;
  } catch (e) {
    return null;
  }
}

/** Returns name -> label id; creates a label the first time it is needed. */
function labelCache_() {
  const byName = {};
  (Gmail.Users.Labels.list('me').labels || []).forEach(l => {
    byName[l.name] = l.id;
  });
  return name => {
    if (!Object.prototype.hasOwnProperty.call(byName, name)) {
      const body = { name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show' };
      byName[name] = Gmail.Users.Labels.create(body, 'me').id;
    }
    return byName[name];
  };
}

/** body.data -> UTF-8 text. The advanced service may give a base64url string or bytes. */
function decode_(data) {
  const bytes = Array.isArray(data) ? data : Utilities.base64DecodeWebSafe(data);
  return Utilities.newBlob(bytes).getDataAsString('UTF-8');
}
