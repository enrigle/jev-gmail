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
      try {
        sortOne_(key, id, labelId);
      } catch (e) {
        if (e.isJevFail) throw e; // bad key or no credit: stop, Google emails the failure
        console.log('error on ' + id + ', skipped: ' + e.message);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/** Sort one email. An unusable Jev answer goes to Review, so it is not retried forever. */
function sortOne_(key, id, labelId) {
  const msg = Gmail.Users.Messages.get('me', id, { format: 'full' });
  const answers = askJev_(key, toState(msg, decode_));
  if (answers === null) return; // 429/5xx/network: still unlabeled, retried next run
  const p = parseAnswers(answers);
  const d = p
    ? decide(p.folder, p.confidence, p.replyP, p.priority, p.stage, p.stageConf)
    : decide('', 0, 0, 0, '', 0); // Review, no star, not important
  const l = labelsFor(d);
  const add = l.names.map(labelId).concat(l.system);
  Gmail.Users.Messages.modify({ addLabelIds: add, removeLabelIds: [] }, 'me', id);
  console.log(
    '[' + d.folder + '] ' + (d.stage || '-') + ' reply=' + d.needsReply +
      ' urgent=' + d.urgent + (p ? '' : ' (unusable answer)') + ' | ' + id,
  );
}

/**
 * POST the questions. Returns `answers`, `{}` when a 200 body is not JSON (goes to Review),
 * or null to skip this email (429/5xx/network, retried next run). Other codes throw.
 */
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
    const err = new Error('OpenRouter ' + code); // no body text: it may echo the email
    err.isJevFail = true;
    throw err;
  }
  try {
    return JSON.parse(resp.getContentText()).answers || {};
  } catch (e) {
    console.log('OpenRouter 200 with a body that is not JSON');
    return {};
  }
}

/** Returns name -> label id; creates a label the first time it is needed.
 * Gmail label names are case-insensitive, so "work" counts as "Work". */
function labelCache_() {
  const byName = {};
  (Gmail.Users.Labels.list('me').labels || []).forEach(l => {
    byName[l.name.toLowerCase()] = l.id;
  });
  return name => {
    const k = name.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(byName, k)) {
      const body = { name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show' };
      byName[k] = Gmail.Users.Labels.create(body, 'me').id;
    }
    return byName[k];
  };
}

/** body.data -> UTF-8 text. The advanced service may give a base64url string or bytes. */
function decode_(data) {
  const bytes = typeof data === 'string' ? Utilities.base64DecodeWebSafe(data) : data;
  return Utilities.newBlob(bytes).getDataAsString('UTF-8');
}
