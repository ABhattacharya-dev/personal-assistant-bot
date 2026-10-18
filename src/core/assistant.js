const config = require('../config');
const { routeUserMessage } = require('./intentRouter');
const expenseRepo = require('../database/expenseRepo');
const reminderRepo = require('../database/reminderRepo');
const memoryRepo = require('../database/memoryRepo');
const userRepo = require('../database/userRepo');

// Format timestamps nicely
function formatTimestamp(ts, timezone = 'Asia/Kolkata') {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(ts));
  } catch (e) {
    return new Date(ts).toLocaleString();
  }
}

// Tone and persona response adapter
function applyToneToReply(baseText, tone = 'friendly', name = '', customPrompt = '') {
  if (!baseText) return baseText;
  const firstName = name ? name.split(' ')[0] : '';

  if (tone === 'motivated') {
    if (baseText.startsWith('Saved:')) {
      return baseText.replace('Saved:', 'Awesome! Recorded') + (firstName ? ` for ${firstName}.` : '') + ' Keep crushing your financial goals! 🚀';
    }
    if (baseText.startsWith('Your total spend')) {
      return `${baseText} Tracking every detail brings financial freedom! 💪`;
    }
    if (baseText.startsWith('Saved to memory')) {
      return `${baseText} Locked in safe and sound! ⭐`;
    }
    if (baseText.startsWith('Reminder scheduled')) {
      return `${baseText} Stay focused and get it done! ⚡`;
    }
  } else if (tone === 'formal') {
    if (baseText.startsWith('Saved:')) {
      return baseText.replace('Saved:', 'Confirmed. Successfully recorded:');
    }
    if (baseText.startsWith('Saved to memory')) {
      return baseText.replace('Saved to memory vault:', 'Committed to memory vault:');
    }
    if (baseText.startsWith('Cancelled')) {
      return `Notice: ${baseText}`;
    }
  } else if (tone === 'casual') {
    if (baseText.startsWith('Saved:')) {
      return baseText.replace('Saved:', 'Got it! Logged').replace('(Category:', 'in').replace(')', '');
    }
    if (baseText.startsWith('Saved to memory')) {
      return baseText.replace('Saved to memory vault:', 'Got it:');
    }
  }

  return baseText;
}

// Channel-agnostic Core Assistant Engine
class AssistantCore {
  constructor(options = {}) {
    this.defaultTimezone = options.timezone || config.DEFAULT_TIMEZONE;
    // Registry of channel notification dispatchers: Map<channel, Function>
    this.channelDispatchers = new Map();
  }

  // Register a delivery channel (e.g., 'web', 'telegram')
  registerChannel(channelName, dispatcherFn) {
    this.channelDispatchers.set(channelName, dispatcherFn);
  }

  // Send an asynchronous notification/reminder to a user
  async notifyUser(userId, channel, reply) {
    // Save to DB notification log
    await reminderRepo.saveNotification(userId, channel, reply.text);

    // Call channel-specific dispatcher if registered
    const dispatcher = this.channelDispatchers.get(channel);
    if (dispatcher) {
      try {
        await dispatcher(userId, reply);
      } catch (err) {
        console.error(`Failed to dispatch notification to user ${userId} on ${channel}:`, err.message);
      }
    }
  }

  // Main entrypoint for processing any incoming message
  async processMessage({ userId, channel = 'web', text = '', attachment = null, timestamp = Date.now() }) {
    const user = await userRepo.ensureUser(userId, this.defaultTimezone);
    const tz = user?.timezone || this.defaultTimezone;

    // 1. Handle attachments (e.g. Images)
    if (attachment && (attachment.type === 'image' || attachment.mimeType?.startsWith('image/'))) {
      if (!config.VISION_MODEL_ENABLED) {
        return {
          text: `Images cannot be read yet with the current CPU model setup. Please type or paste a text note instead, and I'll save it to your memory vault.`,
          action: 'image_unsupported'
        };
      }
    }

    if (!text || !text.trim()) {
      return { text: `How can I help you today? You can log an expense, set a reminder, or save a note.` };
    }

    // 2. Route message through Tier 1 (Fast-Path) & Tier 2 (Model)
    const routing = await routeUserMessage(userId, text, tz, user);

    // 3. Dispatch action based on routing result
    const reply = await this.executeAction(userId, channel, text, routing);

    // 4. Shape reply with user's persona / tone
    if (reply && reply.text && user?.tone) {
      reply.text = applyToneToReply(reply.text, user.tone, user.name, user.system_prompt);
    }

    return reply;
  }

  async executeAction(userId, channel, rawText, routing) {
    const tz = this.defaultTimezone;

    // --- A. FAST-PATH EXECUTIONS ---
    if (routing.mode === 'FAST_PATH') {
      switch (routing.type) {
        case 'CONFIRM_PENDING_ACTION': {
          const { confirmed, pendingAction } = routing;
          await userRepo.clearPendingAction(userId);

          if (!confirmed) {
            return { text: `Cancelled. No changes were made.` };
          }

          if (pendingAction.actionType === 'CONFIRM_DELETE_EXPENSE') {
            const { expenseId, item, amount } = pendingAction.payload;
            await expenseRepo.deleteExpense(expenseId, userId);
            return { text: `Deleted expense: "${item}" for ${amount}.` };
          }

          if (pendingAction.actionType === 'CONFIRM_DELETE_ALL') {
            await userRepo.deleteAllUserData(userId);
            return { text: `All your stored data (expenses, reminders, and notes) has been permanently deleted.` };
          }

          return { text: `Action confirmed.` };
        }

        case 'RESOLVE_MEMORY_CHOICE': {
          const { index, pendingAction } = routing;
          await userRepo.clearPendingAction(userId);
          const matches = pendingAction.payload.matches || [];
          const selected = matches[index];
          if (!selected) {
            return { text: `Invalid choice. Please search again with more specific details.` };
          }
          return {
            text: `Here is the record:\n• ${selected.content} (Date: ${selected.date || 'N/A'})`
          };
        }

        case 'FAST_EXPORT_DATA': {
          const exportData = await userRepo.exportAllUserData(userId);
          return {
            text: `Here is your complete data export:\n\`\`\`json\n${JSON.stringify(exportData, null, 2)}\n\`\`\``,
            action: 'export_data',
            data: exportData
          };
        }

        case 'FAST_DELETE_ALL_PROMPT': {
          await userRepo.setPendingAction(
            userId,
            'CONFIRM_DELETE_ALL',
            {},
            `Are you sure you want to permanently delete ALL your data?`
          );
          return {
            text: `⚠️ Are you sure you want to permanently delete all your stored data (expenses, categories, reminders, and notes)? Reply "yes" to confirm, or "no" to cancel.`
          };
        }

        case 'FAST_DELETE_LAST_PROMPT': {
          const last = await expenseRepo.getLastExpense(userId);
          if (!last) {
            return { text: `You don't have any recorded expenses to delete.` };
          }
          await userRepo.setPendingAction(
            userId,
            'CONFIRM_DELETE_EXPENSE',
            { expenseId: last.id, item: last.item, amount: last.amount },
            `Confirm deleting ${last.item} for ${last.amount}?`
          );
          return {
            text: `Are you sure you want to delete your last expense: "${last.item}" for ${last.amount}? Reply "yes" to confirm or "no" to cancel.`
          };
        }

        case 'FAST_CHANGE_CATEGORY': {
          const last = await expenseRepo.getLastExpense(userId);
          if (!last) {
            return { text: `You don't have any recorded expenses to update.` };
          }
          const updated = await expenseRepo.updateExpenseCategory(last.id, routing.newCategory, userId);
          return {
            text: `Updated your last expense ("${updated.item}") category to ${updated.category}.`
          };
        }

        case 'FAST_CHANGE_AMOUNT': {
          const last = await expenseRepo.getLastExpense(userId);
          if (!last) {
            return { text: `You don't have any recorded expenses to update.` };
          }
          const updated = await expenseRepo.updateExpenseAmount(last.id, routing.newAmount, userId);
          return {
            text: `Updated your last expense ("${updated.item}") amount to ${updated.amount}.`
          };
        }

        case 'FAST_QUERY_EXPENSE': {
          const summary = await expenseRepo.getExpenseSummary(userId, {
            period: routing.period || 'all',
            category: routing.category || null,
            timezone: tz
          });
          if (routing.category) {
            return {
              text: `You spent a total of ${summary.total} ${summary.currency} on ${routing.category}.`
            };
          }
          return {
            text: `Your total spend ${summary.period} is ${summary.total} ${summary.currency} across ${summary.count} entries.`
          };
        }

        case 'FAST_SAVE_PAYMENT_MEMORY': {
          const { entity, amount, details } = routing;
          const savedMem = await memoryRepo.saveMemory(userId, {
            entity,
            amount,
            content: details,
            timezone: tz
          });
          // Also record in expenses as a payment
          await expenseRepo.saveExpense(userId, {
            amount,
            item: `Paid ${entity}`,
            category: 'services',
            rawText: details,
            timezone: tz
          });
          return {
            text: `Saved to memory vault: "${savedMem.content}".`
          };
        }

        case 'FAST_SAVE_NOTE_MEMORY': {
          const savedMem = await memoryRepo.saveMemory(userId, {
            content: routing.details,
            timezone: tz
          });
          return {
            text: `Saved to memory vault: "${savedMem.content}".`
          };
        }

        case 'FAST_QUERY_MEMORY': {
          const matches = await memoryRepo.queryMemory(userId, {
            query: routing.query,
            entity: routing.entity
          });

          if (matches.length === 0) {
            return { text: `I couldn't find any saved notes or payments matching "${routing.query || routing.entity}".` };
          }

          if (matches.length === 1) {
            const item = matches[0];
            return {
              text: `Found 1 record:\n• ${item.content} (Date: ${item.date || 'N/A'})`
            };
          }

          // Multiple matches -> Disambiguation required
          const choices = matches.slice(0, 5).map((m, i) => `${i + 1}. ${m.content} (${m.date || 'N/A'})`);
          await userRepo.setPendingAction(
            userId,
            'RESOLVE_MEMORY_CHOICE',
            { matches: matches.slice(0, 5) },
            `Which record did you mean?`
          );

          return {
            text: `I found ${matches.length} matching records:\n${choices.join('\n')}\nWhich one did you mean? (Reply with 1, 2, or provide more details to narrow down).`,
            choices: choices
          };
        }

        case 'FAST_CANCEL_REMINDER': {
          const cancelledCount = await reminderRepo.cancelReminders(userId, routing.target);
          return {
            text: `Cancelled reminders matching "${routing.target}" (${cancelledCount} removed).`
          };
        }

        case 'FAST_LIST_REMINDERS': {
          const reminders = await reminderRepo.getActiveReminders(userId);
          if (reminders.length === 0) {
            return { text: `You have no active pending reminders.` };
          }
          const list = reminders.map((r, i) => `${i + 1}. "${r.text}" due ${formatTimestamp(r.due_timestamp, tz)}${r.is_recurring ? ' (repeats)' : ''}`).join('\n');
          return { text: `Active Reminders:\n${list}` };
        }

        case 'FAST_AMBIGUOUS': {
          return { text: routing.question };
        }
      }
    }

    // --- B. MODEL ROUTED EXECUTIONS ---
    const intent = routing.intent;

    // 1. Log Expense
    if (intent === 'log_expense' && routing.expense) {
      const exp = routing.expense;
      const saved = await expenseRepo.saveExpense(userId, {
        amount: exp.amount,
        currency: exp.currency || 'INR',
        item: exp.item || 'Item',
        category: exp.category || 'general',
        rawText,
        timezone: tz
      });
      return {
        text: `Saved: ${saved.item} for ${saved.amount} ${saved.currency} (Category: ${saved.category}).`
      };
    }

    // 2. Query Expense (Numbers computed strictly by database)
    if (intent === 'query_expense') {
      const q = routing.expense_query || {};
      const summary = await expenseRepo.getExpenseSummary(userId, {
        period: q.period || 'all',
        category: q.category || null,
        timezone: tz
      });

      if (q.category) {
        return {
          text: `You spent a total of ${summary.total} ${summary.currency} on ${q.category}.`
        };
      }
      return {
        text: `Your total spend ${summary.period} is ${summary.total} ${summary.currency} across ${summary.count} entries.`
      };
    }

    // 3. Set Reminder
    if (intent === 'set_reminder' && routing.reminder) {
      const r = routing.reminder;
      let dueTimestamp = Date.now();
      let intervalSeconds = 0;
      let isRecurring = Boolean(r.is_recurring);

      if (r.every_seconds && r.every_seconds > 0) {
        intervalSeconds = r.every_seconds;
        dueTimestamp += intervalSeconds * 1000;
        isRecurring = true;
      } else if (r.in_seconds && r.in_seconds > 0) {
        dueTimestamp += r.in_seconds * 1000;
      } else {
        // default 5 minutes if unspecified
        dueTimestamp += 300 * 1000;
      }

      const reminder = await reminderRepo.createReminder(userId, {
        text: r.text || 'Reminder',
        dueTimestamp,
        intervalSeconds,
        isRecurring,
        channel
      });

      if (isRecurring) {
        const mins = Math.round(intervalSeconds / 60) || intervalSeconds;
        return {
          text: `Got it! I will remind you every ${mins} minute${mins === 1 ? '' : 's'} to ${reminder.text}.`
        };
      } else {
        return {
          text: `Reminder set for ${formatTimestamp(dueTimestamp, tz)}: "${reminder.text}".`
        };
      }
    }

    // 4. Cancel Reminder
    if (intent === 'cancel_reminder') {
      const target = routing.reminder_cancel?.target || '';
      const count = await reminderRepo.cancelReminders(userId, target);
      return {
        text: `Cancelled ${count} reminder(s) matching "${target}".`
      };
    }

    // 5. Save Memory Vault Item
    if (intent === 'save_memory' && routing.memory) {
      const m = routing.memory;
      const saved = await memoryRepo.saveMemory(userId, {
        entity: m.entity,
        amount: m.amount,
        content: m.details || rawText,
        timezone: tz
      });
      return {
        text: `Saved to memory vault: "${saved.content}".`
      };
    }

    // 6. Query Memory Vault (with Disambiguation)
    if (intent === 'query_memory') {
      const mq = routing.memory_query || {};
      const matches = await memoryRepo.queryMemory(userId, {
        query: mq.query || rawText,
        entity: mq.entity
      });

      if (matches.length === 0) {
        return { text: `I couldn't find any saved notes or payments matching "${mq.query || mq.entity || rawText}".` };
      }

      if (matches.length === 1) {
        const item = matches[0];
        return {
          text: `Found 1 record:\n• ${item.content} (Date: ${item.date || 'N/A'})`
        };
      }

      // Multiple matches -> Disambiguation required
      const choices = matches.slice(0, 5).map((m, i) => `${i + 1}. ${m.content} (${m.date || 'N/A'})`);
      await userRepo.setPendingAction(
        userId,
        'RESOLVE_MEMORY_CHOICE',
        { matches: matches.slice(0, 5) },
        `Which record did you mean?`
      );

      return {
        text: `I found ${matches.length} matching records:\n${choices.join('\n')}\nWhich one did you mean? (Reply with 1, 2, or provide more details to narrow down).`,
        choices: choices
      };
    }

    // 7. Ambiguous
    if (intent === 'ambiguous') {
      return {
        text: routing.clarification || `Could you clarify what you'd like me to do? (e.g. log an expense, set a reminder, or save a note)`
      };
    }

    // 8. General chat or fallback
    return {
      text: routing.reply || `I've noted that. You can log expenses ("rickshaw 10"), set reminders ("remind me in 2 mins to stretch"), or save notes ("I paid Ramesh 500").`
    };
  }
}

module.exports = {
  AssistantCore,
  formatTimestamp
};
