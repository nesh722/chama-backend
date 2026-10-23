const db = require('../config/db');
const { createNotification } = require('../controllers/notificationController');
const { getCurrentCycleLabel, getCycleDaysLeft, describeCycle } = require('./cycle');

// How many days before a cycle ends the reminder goes out
const REMIND_WITHIN_DAYS = { weekly: 2, monthly: 3 };

// Once per group per cycle, reminds members who haven't paid in full that the cycle is ending soon.
async function sendDueSoonReminders() {
  const [groups] = await db.query(
    `SELECT id, name, contribution_amount, contribution_frequency, cycle_anchor_date, last_due_soon_cycle
     FROM groups_table`
  );

  for (const g of groups) {
    const cycle = getCurrentCycleLabel(g.contribution_frequency, g.cycle_anchor_date);
    const progress = getCycleDaysLeft(cycle);
    if (!progress) continue; // old-style week label: no dates to count from

    const window = REMIND_WITHIN_DAYS[g.contribution_frequency] ?? 2;
    if (progress.daysLeft > window) continue; // not close enough to the end yet
    if (g.last_due_soon_cycle === cycle) continue; // already reminded for this cycle

    // Claim the cycle first so two runs can't both send it
    const [claim] = await db.query(
      `UPDATE groups_table SET last_due_soon_cycle = ?
       WHERE id = ? AND (last_due_soon_cycle IS NULL OR last_due_soon_cycle != ?)`,
      [cycle, g.id, cycle]
    );
    if (claim.affectedRows === 0) continue;

    const target = parseFloat(g.contribution_amount);

    // Members who haven't paid in full, except anyone a treasurer/chair already reminded in the last 24 hours
    const [owing] = await db.query(
      `SELECT gm.user_id, COALESCE(c.amount, 0) AS paid
       FROM group_members gm
       LEFT JOIN contributions c
         ON c.group_id = gm.group_id AND c.user_id = gm.user_id AND c.cycle_period = ?
       WHERE gm.group_id = ?
       AND (c.id IS NULL OR c.status != 'paid')
       AND NOT EXISTS (
         SELECT 1 FROM contribution_reminders r
         WHERE r.group_id = gm.group_id AND r.user_id = gm.user_id AND r.cycle_period = ?
         AND r.sent_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
       )`,
      [cycle, g.id, cycle]
    );

    const when =
      progress.daysLeft === 0 ? 'ends today'
      : progress.daysLeft === 1 ? 'ends tomorrow'
      : `ends in ${progress.daysLeft} days`;

    for (const m of owing) {
      const remaining = Math.max(target - parseFloat(m.paid), 0);
      try {
        await createNotification(
          m.user_id,
          'Contribution Due Soon',
          `Your contribution for ${describeCycle(cycle)} in ${g.name} is still pending, and this cycle ${when}. KES ${remaining} remaining of KES ${target}.`
        );
      } catch (err) {
        // No retry: the cycle is already claimed, and retrying would re-notify the others
        console.log(`Due-soon reminder failed for user ${m.user_id}:`, err.message);
      }
    }
  }
}

module.exports = { sendDueSoonReminders };