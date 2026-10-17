const db = require('../config/db');
const PDFDocument = require('pdfkit');

async function getMembership(groupId, userId) {
  const [rows] = await db.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

function isApprover(role) {
  return role === 'treasurer' || role === 'chair';
}

// Cycles between two dates (same logic as the live progress calculation, but
// measured up to an end date instead of "now")
function cyclesBetween(startDate, endDate, frequency) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (frequency === 'weekly') {
    return Math.max(Math.floor((end - start) / (7 * 86400000)) + 1, 1);
  }
  return Math.max((end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1, 1);
}

// Builds { title, columns, rows } for a given report type, already
// scoped to the viewer's role (full group data for treasurer/chair,
// own data only for a regular member).
async function buildReport(groupId, userId, role, type) {
  const scoped = isApprover(role);

  switch (type) {
    case 'contributions': {
      const query = `
        SELECT u.full_name, c.amount, c.cycle_period, c.status, c.paid_at
        FROM contributions c
        JOIN users u ON c.user_id = u.id
        WHERE c.group_id = ? ${scoped ? '' : 'AND c.user_id = ?'}
        ORDER BY c.cycle_period DESC, u.full_name ASC`;
      const params = scoped ? [groupId] : [groupId, userId];
      const [rows] = await db.query(query, params);
      return {
        title: 'Contribution History',
        columns: ['Member', 'Amount', 'Cycle', 'Status', 'Paid At'],
        rows: rows.map(r => [r.full_name, r.amount, r.cycle_period, r.status, r.paid_at ? new Date(r.paid_at).toLocaleString() : '-'])
      };
    }

    case 'loans': {
      const query = `
        SELECT l.id, u.full_name, l.amount, l.status, l.due_date, l.requested_at,
          COALESCE((SELECT SUM(amount_paid) FROM loan_repayments WHERE loan_id = l.id), 0) AS totalRepaid
        FROM loans l
        JOIN users u ON l.user_id = u.id
        WHERE l.group_id = ? ${scoped ? '' : 'AND l.user_id = ?'}
        ORDER BY l.requested_at DESC`;
      const params = scoped ? [groupId] : [groupId, userId];
      const [rows] = await db.query(query, params);
      return {
        title: 'Loan Activity',
        columns: ['Member', 'Amount', 'Status', 'Due Date', 'Requested', 'Repaid So Far'],
        rows: rows.map(r => [
          r.full_name, r.amount, r.status,
          r.due_date ? new Date(r.due_date).toLocaleDateString() : '-',
          new Date(r.requested_at).toLocaleString(),
          r.totalRepaid
        ])
      };
    }

        case 'payouts': {
      const params = scoped ? [groupId] : [groupId, userId];

      // Current (in-progress or just-finished) rotation, with the amount paid
      // pulled from the transactions ledger
      const [currentRows] = await db.query(
        `SELECT u.full_name, pr.rotation_order, pr.has_received, pr.received_at, t.amount
         FROM payout_rotations pr
         JOIN users u ON pr.user_id = u.id
         LEFT JOIN transactions t ON t.type = 'payout' AND t.reference_id = pr.id
         WHERE pr.group_id = ? ${scoped ? '' : 'AND pr.user_id = ?'}
         ORDER BY pr.rotation_order ASC`,
        params
      );

      // Archived past cycles
      const [historyRows] = await db.query(
        `SELECT h.cycle_number, u.full_name, h.rotation_order, h.has_received, h.received_at, h.amount
         FROM payout_rotation_history h
         JOIN users u ON h.user_id = u.id
         WHERE h.group_id = ? ${scoped ? '' : 'AND h.user_id = ?'}
         ORDER BY h.cycle_number DESC, h.rotation_order ASC`,
        params
      );

      // The current cycle's number is one past the latest archived cycle. This is
      // looked up separately so a member's filtered view still numbers it correctly.
      const [maxRows] = await db.query(
        'SELECT COALESCE(MAX(cycle_number), 0) AS maxCycle FROM payout_rotation_history WHERE group_id = ?',
        [groupId]
      );
      const currentCycleNumber = maxRows[0].maxCycle + 1;

      const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '-');
      const fmtAmount = (a) => (a != null ? a : '-');

      return {
        title: 'Payout Rotation History',
        columns: ['Cycle', 'Member', 'Order', 'Received?', 'Amount', 'Received At'],
        rows: [
          ...currentRows.map((r) => [
            `${currentCycleNumber} (current)`,
            r.full_name,
            r.rotation_order,
            r.has_received ? 'Yes' : 'No',
            fmtAmount(r.amount),
            fmtDate(r.received_at)
          ]),
          ...historyRows.map((r) => [
            r.cycle_number,
            r.full_name,
            r.rotation_order,
            r.has_received ? 'Yes' : 'No',
            fmtAmount(r.amount),
            fmtDate(r.received_at)
          ])
        ]
      };
    }

       case 'savings_target': {
      const [groupRows] = await db.query(
        'SELECT savings_target, target_start_date, contribution_frequency FROM groups_table WHERE id = ?',
        [groupId]
      );
      const group = groupRows[0];
      const fmtDate = (d) => new Date(d).toLocaleDateString();
      const reportRows = [];

      // --- Current target, if one is set (progress counts everything paid so far) ---
      if (group && group.savings_target) {
        const targetToDate =
          parseFloat(group.savings_target) *
          cyclesBetween(group.target_start_date, new Date(), group.contribution_frequency);

        const [currentMembers] = await db.query(
          `SELECT u.id, u.full_name,
            COALESCE((SELECT SUM(amount) FROM contributions WHERE user_id = u.id AND group_id = gm.group_id AND status = 'paid'), 0)
            + COALESCE((SELECT SUM(amount) FROM savings_deposits WHERE user_id = u.id AND group_id = gm.group_id), 0) AS paidToDate
           FROM group_members gm
           JOIN users u ON gm.user_id = u.id
           WHERE gm.group_id = ? ${scoped ? '' : 'AND u.id = ?'}
           GROUP BY u.id, u.full_name`,
          scoped ? [groupId] : [groupId, userId]
        );

        for (const m of currentMembers) {
          const paid = parseFloat(m.paidToDate);
          reportRows.push([
            `Current (since ${fmtDate(group.target_start_date)})`,
            m.full_name,
            targetToDate,
            paid,
            paid >= targetToDate ? 'On Track' : 'Behind'
          ]);
        }
      }

      // --- Archived targets: how each member did during that target's active window ---
      const [history] = await db.query(
        `SELECT id, savings_target, target_start_date, target_end_date, ended_reason
         FROM savings_target_history
         WHERE group_id = ?
         ORDER BY target_end_date DESC, id DESC`,
        [groupId]
      );

      for (const h of history) {
        const targetForPeriod =
          parseFloat(h.savings_target) *
          cyclesBetween(h.target_start_date, h.target_end_date, group.contribution_frequency);

        const [periodMembers] = await db.query(
          `SELECT u.id, u.full_name,
            COALESCE((SELECT SUM(amount) FROM contributions
                      WHERE user_id = u.id AND group_id = gm.group_id AND status = 'paid'
                        AND paid_at >= ? AND paid_at < DATE_ADD(?, INTERVAL 1 DAY)), 0)
            + COALESCE((SELECT SUM(amount) FROM savings_deposits
                        WHERE user_id = u.id AND group_id = gm.group_id
                          AND deposited_at >= ? AND deposited_at < DATE_ADD(?, INTERVAL 1 DAY)), 0) AS paidInPeriod
           FROM group_members gm
           JOIN users u ON gm.user_id = u.id
           WHERE gm.group_id = ? ${scoped ? '' : 'AND u.id = ?'}
           GROUP BY u.id, u.full_name`,
          scoped
            ? [h.target_start_date, h.target_end_date, h.target_start_date, h.target_end_date, groupId]
            : [h.target_start_date, h.target_end_date, h.target_start_date, h.target_end_date, groupId, userId]
        );

        for (const m of periodMembers) {
          const paid = parseFloat(m.paidInPeriod);
          reportRows.push([
            `${fmtDate(h.target_start_date)} - ${fmtDate(h.target_end_date)} (${h.ended_reason})`,
            m.full_name,
            targetForPeriod,
            paid,
            paid >= targetForPeriod ? 'Met' : 'Short'
          ]);
        }
      }

      return {
        title: 'Savings Target History',
        columns: ['Period', 'Member', 'Target', 'Paid', 'Status'],
        rows: reportRows
      };
    }

    case 'summary': {
      const query = `
        SELECT u.full_name, t.type, t.amount, t.created_at
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        WHERE t.group_id = ? ${scoped ? '' : 'AND t.user_id = ?'}
        ORDER BY t.created_at DESC`;
      const params = scoped ? [groupId] : [groupId, userId];
      const [rows] = await db.query(query, params);
      return {
        title: 'Group Financial Summary',
        columns: ['Member', 'Type', 'Amount', 'Date'],
        rows: rows.map(r => [r.full_name, r.type, r.amount, new Date(r.created_at).toLocaleString()])
      };
    }

    default:
      return null;
  }
}

// GET /reports/:groupId/:type -> JSON for in-app display
exports.getReport = async (req, res) => {
  try {
    const { groupId, type } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const report = await buildReport(groupId, userId, role, type);
    if (!report) {
      return res.status(400).json({ success: false, message: 'Unknown report type' });
    }

    res.json({ success: true, ...report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /reports/:groupId/:type/export?format=csv|pdf
exports.exportReport = async (req, res) => {
  try {
    const { groupId, type } = req.params;
    const { format } = req.query;
    const userId = req.user.userId;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }
    if (!['csv', 'pdf'].includes(format)) {
      return res.status(400).json({ success: false, message: 'format must be csv or pdf' });
    }

    const report = await buildReport(groupId, userId, role, type);
    if (!report) {
      return res.status(400).json({ success: false, message: 'Unknown report type' });
    }

    const filename = `${type}-report-${groupId}.${format}`;

    if (format === 'csv') {
      const escape = (val) => {
        const s = String(val ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [report.columns.map(escape).join(',')];
      for (const row of report.rows) {
        lines.push(row.map(escape).join(','));
      }
      const csv = lines.join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(csv);
    }

    // PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(18).text(report.title, { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('gray').text(`Generated ${new Date().toLocaleString()}`);
    doc.moveDown(1);
    doc.fillColor('black');

    const colCount = report.columns.length;
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidth = usableWidth / colCount;
    const startX = doc.page.margins.left;

    // Draws one row and returns how tall it actually rendered, so the caller
    // can advance y by the real height instead of a fixed guess -- prevents
    // wrapped multi-line cells from overlapping the next row.
    const drawRow = (values, y, bold) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      let maxHeight = 14;
      values.forEach((val, i) => {
        const text = val === null || val === undefined || val === '' ? '-' : String(val);
        const h = doc.heightOfString(text, { width: colWidth - 6 });
        maxHeight = Math.max(maxHeight, h);
        doc.text(text, startX + i * colWidth, y, { width: colWidth - 6 });
      });
      return maxHeight + 6;
    };

    const drawHeaderAt = (y) => {
      const h = drawRow(report.columns, y, true);
      const lineY = y + h - 4;
      doc.moveTo(startX, lineY).lineTo(startX + usableWidth, lineY).strokeColor('#ccc').stroke();
      return y + h;
    };

    let y = drawHeaderAt(doc.y);

    if (report.rows.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor('gray').text('No data for this report.', startX, y + 10);
    }

    for (const row of report.rows) {
      if (y > doc.page.height - doc.page.margins.bottom - 40) {
        doc.addPage();
        y = drawHeaderAt(doc.page.margins.top);
      }
      const rowHeight = drawRow(row, y, false);
      y += rowHeight;
    }

    doc.end();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};