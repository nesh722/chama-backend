const db = require('../config/db');
const { createNotification } = require('../controllers/notificationController');
const { getCurrentCycleLabel } = require('./cycle');

const shortDate = (d) => d.toLocaleString('en-US', { month: 'short', day: 'numeric' });

function cycleMessage(group, cycle) {
  if (group.contribution_frequency === 'weekly') {
    const [y, m, d] = cycle.split('-').map(Number);
    const start = new Date(y, m - 1, d);
    const end = new Date(y, m - 1, d + 6);
    return `A new week has begun in ${group.name} (${shortDate(start)} - ${shortDate(end)}). Your contribution of KES ${group.contribution_amount} is due this week.`;
  }
  const [year, month] = cycle.split('-').map(Number);
  const monthName = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return `${monthName} has begun in ${group.name}. Your contribution of KES ${group.contribution_amount} is due this month.`;
}

// Tells members of each group when a new contribution cycle has started.
async function announceNewCycles() {
  const [groups] = await db.query(
    `SELECT id, name, contribution_amount, contribution_frequency, cycle_anchor_date, last_cycle_announced
     FROM groups_table`
  );

  for (const g of groups) {
    const cycle = getCurrentCycleLabel(g.contribution_frequency, g.cycle_anchor_date);
    const last = g.last_cycle_announced;

    // No baseline yet, or the label format changed (frequency switched, or the old
    // 'YYYY-Www' weekly format): record the current cycle silently instead of announcing
    if (!last || last.length !== cycle.length) {
      await db.query('UPDATE groups_table SET last_cycle_announced = ? WHERE id = ?', [cycle, g.id]);
      continue;
    }

    if (last === cycle) continue;

    // Claim the cycle first so two runs can't both announce it
    const [claim] = await db.query(
      'UPDATE groups_table SET last_cycle_announced = ? WHERE id = ? AND last_cycle_announced = ?',
      [cycle, g.id, last]
    );
    if (claim.affectedRows === 0) continue;

    // Everyone in the group who hasn't already paid for this cycle
    const [members] = await db.query(
      `SELECT gm.user_id FROM group_members gm
       WHERE gm.group_id = ?
       AND gm.user_id NOT IN (
         SELECT user_id FROM contributions
         WHERE group_id = ? AND cycle_period = ? AND status = 'paid'
       )`,
      [g.id, g.id, cycle]
    );

    for (const m of members) {
      try {
        await createNotification(m.user_id, 'New Contribution Cycle', cycleMessage(g, cycle));
      } catch (err) {
        console.log(`Cycle notification failed for user ${m.user_id}:`, err.message);
      }
    }
  }
}

module.exports = { announceNewCycles };