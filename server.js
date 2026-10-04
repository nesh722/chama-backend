require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const groupRoutes = require('./routes/groupRoutes');
const contributionRoutes = require('./routes/contributionRoutes');
const loanRoutes = require('./routes/loanRoutes');
const payoutRoutes = require('./routes/payoutRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const activityRoutes = require('./routes/activityRoutes');
const savingsRoutes = require('./routes/savingsRoutes');
const reportRoutes = require('./routes/reportRoutes');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));
app.use('/api/reports', reportRoutes);

// Test route
app.get('/', (req, res) => {
  res.json({ message: 'Chama API is running' });
});

// Test DB connection route
app.get('/api/test-db', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT 1 + 1 AS result');
    res.json({ success: true, result: rows[0].result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Auth routes
app.use('/api/auth', authRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/contributions', contributionRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/savings', savingsRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
