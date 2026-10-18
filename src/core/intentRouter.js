const { parseMessageWithModel } = require('./modelClient');
const expenseRepo = require('../database/expenseRepo');
const reminderRepo = require('../database/reminderRepo');
const memoryRepo = require('../database/memoryRepo');
const userRepo = require('../database/userRepo');

// Fast-path intent matching to avoid ~6s CPU model calls for deterministic actions
function tryFastPathMatch(text, pendingAction = null) {
  const clean = text.trim();
  const lower = clean.toLowerCase();

  // 1. Pending action handling
  if (pendingAction) {
    if (/^(yes|y|confirm|haan|ha|sahi|thik|sure|proceed)$/i.test(lower)) {
      return { type: 'CONFIRM_PENDING_ACTION', confirmed: true, pendingAction };
    }
    if (/^(no|n|cancel|na|nahi|stop|abort)$/i.test(lower)) {
      return { type: 'CONFIRM_PENDING_ACTION', confirmed: false, pendingAction };
    }
    // Number choice for memory disambiguation (e.g. "1", "2", "the first one", "second")
    if (pendingAction.actionType === 'RESOLVE_MEMORY_CHOICE') {
      const matchNum = lower.match(/\b(1|2|3|4|5|first|second|third|fourth|fifth)\b/);
      if (matchNum) {
        const wordMap = { '1': 0, 'first': 0, '2': 1, 'second': 1, '3': 2, 'third': 2, '4': 3, 'fourth': 3, '5': 4, 'fifth': 4 };
        const index = wordMap[matchNum[1]];
        return { type: 'RESOLVE_MEMORY_CHOICE', index, pendingAction };
      }
    }
  }

  // 2. Data Export & Privacy
  if (/^(export(\s+all)?(\s+my)?(\s+data)?|\/export)$/i.test(lower)) {
    return { type: 'FAST_EXPORT_DATA' };
  }
  if (/^(delete\s+all(\s+my)?\s+data|clear\s+all(\s+my)?\s+data|wipe\s+all(\s+my)?\s+data|\/delete_all)$/i.test(lower)) {
    return { type: 'FAST_DELETE_ALL_PROMPT' };
  }

  // 3. Corrections & Undo
  // "change that to food", "change category to groceries", "change to transport"
  const catMatch = lower.match(/^(?:change\s+(?:that|it|category)\s+to|make\s+that)\s+([a-zA-Z0-9_\s]+)$/i);
  if (catMatch) {
    return { type: 'FAST_CHANGE_CATEGORY', newCategory: catMatch[1].trim() };
  }

  // "change amount to 50"
  const amtMatch = lower.match(/^change\s+amount\s+to\s+([0-9.]+)/i);
  if (amtMatch) {
    return { type: 'FAST_CHANGE_AMOUNT', newAmount: parseFloat(amtMatch[1]) };
  }

  // "delete the last one", "delete last entry", "delete last expense"
  if (/^(delete(\s+the)?\s+last(\s+one|\s+expense|\s+entry)?|undo)$/i.test(lower)) {
    return { type: 'FAST_DELETE_LAST_PROMPT' };
  }

  // 4. Common Expense Queries
  // "how much did I spend today", "today spend", "aaj kitna kharch hua"
  if (/^(how\s+much\s+(did\s+i\s+spend|spent)\s+today|today('s)?\s+spend|aaj\s+(kitna|koto)\s+kharach)/i.test(lower)) {
    return { type: 'FAST_QUERY_EXPENSE', period: 'today' };
  }
  // "how much did I spend yesterday", "yesterday spend"
  if (/^(how\s+much\s+(did\s+i\s+spend|spent)\s+yesterday|yesterday('s)?\s+spend|kal\s+(kitna|koto)\s+kharach)/i.test(lower)) {
    return { type: 'FAST_QUERY_EXPENSE', period: 'yesterday' };
  }
  // "how much did I spend this month", "this month spend"
  if (/^(how\s+much\s+(did\s+i\s+spend|spent)\s+this\s+month|this\s+month('s)?\s+spend|ei\s+mashe\s+kharach)/i.test(lower)) {
    return { type: 'FAST_QUERY_EXPENSE', period: 'this_month' };
  }
  // "how much on transport?", "how much did I spend on food?"
  const catQueryMatch = lower.match(/^how\s+much\s+(?:did\s+i\s+spend\s+)?on\s+([a-zA-Z]+)\??$/i);
  if (catQueryMatch) {
    return { type: 'FAST_QUERY_EXPENSE', category: catQueryMatch[1].trim(), period: 'all' };
  }

  // 5. Memory Vault Fast-Paths
  // "I paid Ramesh 500 for the electrician today"
  const paidMatch = lower.match(/^i\s+paid\s+([a-zA-Z]+)\s+([0-9.]+)\s+(?:for\s+)?(.*)$/i);
  if (paidMatch) {
    const rawEntity = clean.split(/\s+/)[2]; // Preserve capitalisation of name
    return {
      type: 'FAST_SAVE_PAYMENT_MEMORY',
      entity: rawEntity,
      amount: parseFloat(paidMatch[2]),
      details: clean
    };
  }

  // "what did I pay Ramesh?"
  const queryPaidMatch = lower.match(/^(?:what\s+did\s+i\s+pay|how\s+much\s+did\s+i\s+pay)\s+([a-zA-Z]+)\??$/i);
  if (queryPaidMatch) {
    const rawEntity = clean.split(/\s+/).slice(-1)[0].replace(/[^a-zA-Z]/g, '');
    return {
      type: 'FAST_QUERY_MEMORY',
      entity: rawEntity,
      query: rawEntity
    };
  }

  // "Remember my locker code is 4491"
  const rememberMatch = lower.match(/^remember\s+(?:that\s+)?(.+)$/i);
  if (rememberMatch) {
    return {
      type: 'FAST_SAVE_NOTE_MEMORY',
      details: clean
    };
  }

  // "what is my locker code?"
  const queryNoteMatch = lower.match(/^what\s+is\s+my\s+([a-zA-Z0-9_\s]+)\??$/i);
  if (queryNoteMatch) {
    return {
      type: 'FAST_QUERY_MEMORY',
      query: queryNoteMatch[1].trim()
    };
  }

  // 6. Common Reminder Cancellations
  // "stop the water reminder", "cancel water reminder", "stop reminder"
  const cancelReminderMatch = lower.match(/^(?:stop|cancel)(?:\s+the)?\s+(.+?)(?:\s+reminder|\s+alert)?$/i);
  if (cancelReminderMatch) {
    const target = cancelReminderMatch[1].trim();
    if (target !== 'all' && target.length > 1) {
      return { type: 'FAST_CANCEL_REMINDER', target };
    }
  }

  // "list reminders", "show reminders"
  if (/^(list|show|get)\s+reminders$/i.test(lower)) {
    return { type: 'FAST_LIST_REMINDERS' };
  }

  // 7. Fast Ambiguity Detection (e.g. bare number with no item, or bare single word)
  if (/^\$?\d+(\.\d+)?$/.test(clean)) {
    return {
      type: 'FAST_AMBIGUOUS',
      question: `I noticed an amount of ${clean}. What was this expense for (e.g., "taxi ${clean}")?`
    };
  }

  if (/^(expense|payment|bill|money|kharch)$/i.test(lower)) {
    return {
      type: 'FAST_AMBIGUOUS',
      question: `Could you clarify what you'd like to record? (e.g., "rickshaw 50" or "paid electricity bill 1200")`
    };
  }

  return null; // Route to Model
}

// Router combining Tier 1 Fast-Path and Tier 2 Model Parsing
async function routeUserMessage(userId, text, timezone = 'Asia/Kolkata', profile = {}) {
  const pendingAction = await userRepo.getPendingAction(userId);

  // Check Fast-Path first (< 5ms response time)
  const fastMatch = tryFastPathMatch(text, pendingAction);
  if (fastMatch) {
    return { mode: 'FAST_PATH', ...fastMatch };
  }

  // Route to Model
  const categories = await expenseRepo.getUserCategories(userId);
  const modelResult = await parseMessageWithModel(text, categories, timezone, profile);
  return { mode: 'MODEL', ...modelResult };
}

module.exports = {
  tryFastPathMatch,
  routeUserMessage
};
