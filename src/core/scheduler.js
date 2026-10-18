const fs = require('fs');
const path = require('path');
const config = require('../config');
const reminderRepo = require('../database/reminderRepo');

class Scheduler {
  constructor(assistant) {
    this.assistant = assistant;
    this.intervalId = null;
    this.lastBackupTime = 0;
  }

  start() {
    if (this.intervalId) return;

    this.intervalId = setInterval(async () => {
      await this.checkDueReminders();
      await this.checkScheduledBackup();
    }, config.REMINDER_CHECK_INTERVAL_MS);

    console.log(`[Scheduler] Reminder engine running (interval: ${config.REMINDER_CHECK_INTERVAL_MS}ms)`);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async checkDueReminders() {
    try {
      const now = Date.now();
      const dueReminders = await reminderRepo.getDueReminders(now);

      for (const reminder of dueReminders) {
        // Dispatch notification to user
        await this.assistant.notifyUser(reminder.user_id, reminder.channel || 'web', {
          text: `🔔 Reminder: ${reminder.text}`,
          action: 'reminder_alert',
          metadata: { reminderId: reminder.id }
        });

        if (reminder.is_recurring && reminder.interval_seconds > 0) {
          // Schedule next occurrence
          const nextDue = now + reminder.interval_seconds * 1000;
          await reminderRepo.rescheduleRecurringReminder(reminder.id, nextDue);
        } else {
          // Mark single-shot reminder delivered
          await reminderRepo.markReminderDelivered(reminder.id);
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error processing due reminders:', err.message);
    }
  }

  async checkScheduledBackup() {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    if (now - this.lastBackupTime < ONE_DAY_MS) return;

    try {
      if (!fs.existsSync(config.BACKUP_DIR)) {
        fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
      }

      if (fs.existsSync(config.DB_PATH)) {
        const dateStr = new Date().toISOString().slice(0, 10);
        const backupFile = path.join(config.BACKUP_DIR, `assistant_${dateStr}.db`);
        fs.copyFileSync(config.DB_PATH, backupFile);
        this.lastBackupTime = now;
        console.log(`[Scheduler] Database backed up to ${backupFile}`);
      }
    } catch (err) {
      console.error('[Scheduler] Database backup failed:', err.message);
    }
  }
}

module.exports = {
  Scheduler
};
