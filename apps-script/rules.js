/**
 * Pure sorting rules for the Gmail Jev sorter (port of gmail_jev_sorter.py).
 * Apps Script loads this as globals; node tests load it through module.exports.
 * No Apps Script services here: everything is testable with `node --test`.
 */

const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = 'typesafe/jev-1.13';
const FOLDER_MIN = 0.7; // min Choice confidence to file, else Review
const REPLY_MIN = 0.6; // min Noul probability to star
const URGENT = 1.5; // Score 0..2: closer to "Today" than "This week"
const MAX_PER_RUN = 20; // Apps Script stops a run after 6 min
const MAX_BODY = 1000; // body characters sent to Jev

// Keys are Gmail label names; no "/" in keys or Gmail nests them. "Personal" reuses yours.
const FOLDERS = {
  Work: {
    what: 'My current job: projects, colleagues, meetings, work tools',
    not_for: 'Recruiting, job offers or applications (use Jobs)',
  },
  Jobs: {
    what: 'Recruiters, job alerts, job applications, interviews',
    examples: [
      'Interview invitation',
      'X busca personal para el puesto de...',
      'LinkedIn profile views',
      'Company viewed your application',
      'Infojobs',
    ],
  },
  Finance: {
    what: 'Bank, invoices, receipts, payments',
    not_for: 'Tax agency or traffic authority (use Tax)',
    examples: ['Fintonic', 'Santander Informa', 'unicaja', 'Factura', 'Recibo'],
  },
  Tax: {
    what: 'Tax and government notices: tax returns, fines, official notifications',
    examples: [
      'AEAT / Agencia Tributaria',
      'DGT / Dirección General de Tráfico',
      'Renta declaracion',
      'Multa de tráfico',
    ],
  },
  House: {
    what: 'Finding, buying, selling or renting a home',
    examples: ['Idealista alerts and messages', 'Property listings', 'Rental offers'],
  },
  Shopping: {
    what: 'Orders, shipping, buying and selling on marketplaces',
    examples: ['Vinted', 'Wallapop', 'Amazon order', 'Shipping label'],
  },
  Accounts: {
    what: 'Account and security notices',
    examples: [
      'Login or one-time code',
      'You shared Google account data with an app',
      'Security incident notice',
      'Terms or legal changes',
    ],
  },
  Kids: {
    what: "My children's school and activities",
    examples: ['ceip', 'extraescolares'],
  },
  Courses: {
    what: 'Online courses and learning platforms',
    examples: ['Coursera', 'MITx', 'edX', 'Udemy', 'DeepLearning.AI'],
  },
  Language: {
    what: 'Language lessons and tutors',
    examples: ['Preply'],
  },
  Newsletters: {
    what: 'Subscriptions, digests, articles, marketing, promotions',
    examples: ['Medium', 'TLDR', 'New York Times', 'Real Python'],
  },
  Personal: 'Family, friends, personal appointments',
  Other: 'None of the above clearly fits',
};
const PRIORITY_LEVELS = ['Can wait', 'This week', 'Today'];
// Keys become "Jobs-<key>" labels, added next to "Jobs".
const JOB_STAGES = {
  Alert: 'Job alerts, job recommendations, profile views',
  Outreach: 'A recruiter or company contacts me first about a role',
  Applied: 'Confirmation that my application was received or viewed',
  Interview: 'Interview invitation, scheduling, assessment or test',
  Rejected: 'My application was declined',
  Offer: 'Job offer or contract',
};
// Skip emails that already carry any folder label: re-runs only sort new mail.
const QUERY =
  'in:inbox ' + Object.keys(FOLDERS).concat(['Review']).map(n => '-label:' + n).join(' ');

const QUESTIONS = {
  folder: { type: 'choice', instructions: 'Which folder does this email belong in?', criteria: FOLDERS },
  needs_reply: { type: 'noul', instructions: 'Does the sender expect a personal reply from me?' },
  priority: {
    type: 'score',
    instructions:
      'How soon must I personally act on this email? Ignore marketing, sales or fundraising urgency.',
    criteria: PRIORITY_LEVELS,
  },
  // Asked for every email (same request, near-free); used only when folder is Jobs.
  job_stage: {
    type: 'choice',
    instructions: 'If this email is about my job search, what stage is it?',
    criteria: JOB_STAGES,
  },
};

/** Own key only: "toString" must not count as a folder. */
function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** "Jobs-<stage>" for a confident, known stage on a Jobs email, else "". NaN -> "". */
function jobStage(folder, stage, confidence) {
  return folder === 'Jobs' && has(JOB_STAGES, stage) && confidence >= FOLDER_MIN
    ? 'Jobs-' + stage
    : '';
}

/**
 * Jev's raw judgments -> actions. Unknown folders go to Review: the answer becomes a
 * Gmail label name, and names like "SPAM" would hit system labels. NaN compares false.
 */
function decide(folder, confidence, replyP, priority, stage, stageConf) {
  const f = has(FOLDERS, folder) && confidence >= FOLDER_MIN ? folder : 'Review';
  return {
    folder: f,
    needsReply: replyP >= REPLY_MIN,
    urgent: priority >= URGENT,
    stage: jobStage(f, stage, stageConf),
  };
}

/** Pull the six numbers/strings out of Jev's `answers`; null if any is missing or mistyped. */
function parseAnswers(answers) {
  try {
    const p = {
      folder: answers.folder.choice,
      confidence: answers.folder.confidence,
      replyP: answers.needs_reply.noul,
      priority: answers.priority.score,
      stage: answers.job_stage.choice,
      stageConf: answers.job_stage.confidence,
    };
    const numbers = [p.confidence, p.replyP, p.priority, p.stageConf];
    const ok =
      typeof p.folder === 'string' &&
      typeof p.stage === 'string' &&
      numbers.every(n => typeof n === 'number');
    return ok ? p : null;
  } catch (e) {
    return null; // answers or one of its parts is null/undefined
  }
}

/** Label names to resolve to ids (folder, stage) and system label ids to add. */
function labelsFor(d) {
  return {
    names: [d.folder, d.stage].filter(Boolean),
    system: (d.needsReply ? ['STARRED'] : []).concat(d.urgent ? ['IMPORTANT'] : []),
  };
}

/** 200 ok; 429/5xx retry next run; other codes (bad key, no credit) stop the run. */
function jevStatus(code) {
  if (code === 200) return 'ok';
  return code === 429 || code >= 500 ? 'skip' : 'fail';
}

/** First text/plain part, depth-first; "" if none. `decode` turns body.data into text. */
function plainText(payload, decode) {
  const data = payload && payload.body && payload.body.data;
  if (payload && payload.mimeType === 'text/plain' && data) return decode(data);
  for (const part of (payload && payload.parts) || []) {
    const text = plainText(part, decode);
    if (text) return text;
  }
  return '';
}

/** Gmail message -> the state Jev sees: from, subject, body capped at maxBody chars. */
function toState(msg, decode, maxBody = MAX_BODY) {
  const headers = {};
  for (const h of (msg.payload && msg.payload.headers) || []) headers[h.name.toLowerCase()] = h.value;
  const body = plainText(msg.payload, decode) || msg.snippet || '';
  return {
    from: headers.from || '',
    subject: headers.subject || '',
    body: body.slice(0, Math.max(maxBody, 0)),
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    JEV_URL, JEV_MODEL, FOLDER_MIN, REPLY_MIN, URGENT, MAX_PER_RUN, MAX_BODY,
    FOLDERS, PRIORITY_LEVELS, JOB_STAGES, QUERY, QUESTIONS,
    jobStage, decide, parseAnswers, labelsFor, jevStatus, plainText, toState,
  };
}
