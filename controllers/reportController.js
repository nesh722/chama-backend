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
      const query = `
        SELECT u.full_name, pr.rotation_order, pr.has_received, pr.received_at
        FROM payout_rotations pr
        JOIN users u ON pr.user_id = u.id
        WHERE pr.group_id = ? ${scoped ? '' : 'AND pr.user_id = ?'}
        ORDER BY pr.rotation_order ASC`;
      const params = scoped ? [groupId] : [groupId, userId];
      const [rows] = await db.query(query, params);
      return {
        title: 'Payout Rotation History',
        columns: ['Member', 'Order', 'Received?', 'Received At'],
        rows: rows.map(r => [r.full_name, r.rotation_order, r.has_received ? 'Yes' : 'No', r.received_at ? new Date(r.received_at).toLocaleString() : '-'])
      };
    }

    case 'savings_target': {
      const [groupRows] = await db.query(
        'SELECT savings_target, target_start_date, contribution_frequency FROM groups_table WHERE id = ?',
        [groupId]
      );
      const group = groupRows[0];
      if (!group || !group.savings_target) {
        return { title: 'Savings Target Progress', columns: ['Member', 'Paid To Date', 'Target To Date', 'Status'], rows: [] };
      }

      const now = new Date();
      const start = new Date(group.target_start_date);
      let cyclesElapsed;
      if (group.contribution_frequency === 'weekly') {
        cyclesElapsed = Math.max(Math.floor((now - start) / (7 * 86400000)) + 1, 1);
      } else {
        cyclesElapsed = Math.max((now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()) + 1, 1);
      }
      const targetToDate = parseFloat(group.savings_target) * cyclesElapsed;

      const query = `
        SELECT u.id, u.full_name,
          COALESCE((SELECT SUM(amount) FROM contributions WHERE user_id = u.id AND group_id = gm.group_id AND status = 'paid'), 0)
          + COALESCE((SELECT SUM(amount) FROM savings_deposits WHERE user_id = u.id AND group_id = gm.group_id), 0) AS paidToDate
        FROM group_members gm
        JOIN users u ON gm.user_id = u.id
        WHERE gm.group_id = ? ${scoped ? '' : 'AND u.id = ?'}
        GROUP BY u.id, u.full_name`;
      const params = scoped ? [groupId] : [groupId, userId];
      const [rows] = await db.query(query, params);

      return {
        title: 'Savings Target Progress',
        columns: ['Member', 'Paid To Date', 'Target To Date', 'Status'],
        rows: rows.map(r => {
          const paid = parseFloat(r.paidToDate);
          return [r.full_name, paid, targetToDate, paid >= targetToDate ? 'On Track' : 'Behind'];
        })
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
        const text = String(val ?? '-');
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