CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE TABLE groups_table (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    contribution_amount DECIMAL(12,2) NOT NULL,
    contribution_frequency ENUM('weekly','monthly') NOT NULL DEFAULT 'monthly',
    created_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE TABLE group_members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    user_id INT NOT NULL,
    role ENUM('chair','treasurer','secretary','member') NOT NULL DEFAULT 'member',
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_membership (group_id, user_id)
);
CREATE TABLE contributions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    user_id INT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    cycle_period VARCHAR(20) NOT NULL,   -- e.g. '2026-09' for monthly
    status ENUM('pending','paid','late') NOT NULL DEFAULT 'pending',
    paid_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE loans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    user_id INT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    status ENUM('requested','approved','rejected','repaid') NOT NULL DEFAULT 'requested',
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    approved_at TIMESTAMP NULL,
    approved_by INT NULL,
    FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (approved_by) REFERENCES users(id)
);
CREATE TABLE loan_repayments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    loan_id INT NOT NULL,
    amount_paid DECIMAL(12,2) NOT NULL,
    paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
);
CREATE TABLE payout_rotations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    user_id INT NOT NULL,
    rotation_order INT NOT NULL,
    has_received BOOLEAN DEFAULT FALSE,
    received_at TIMESTAMP NULL,
    FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    user_id INT NOT NULL,
    type ENUM('contribution','loan_disbursement','loan_repayment','payout') NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    reference_id INT NULL,   -- links back to contributions/loans/payout_rotations id
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE password_resets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
ALTER TABLE users ADD COLUMN avatar_url VARCHAR(255) NULL;
ALTER TABLE groups_table ADD COLUMN savings_target DECIMAL(12,2) NULL;
ALTER TABLE groups_table ADD COLUMN target_start_date DATE NULL;
CREATE TABLE activity_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  group_id INT NULL,
  action_type VARCHAR(50) NOT NULL,
  description TEXT NOT NULL,
  amount DECIMAL(10,2) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE SET NULL
);
ALTER TABLE loans
  ADD COLUMN due_date DATE NULL AFTER amount,
  ADD COLUMN overdue_notified BOOLEAN NOT NULL DEFAULT FALSE AFTER due_date;
ALTER TABLE groups_table ADD COLUMN invite_token VARCHAR(32) NULL UNIQUE AFTER id;
CREATE TABLE savings_deposits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  user_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  note VARCHAR(255) NULL,
  deposited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE savings_target_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  savings_target DECIMAL(10,2) NOT NULL,
  target_start_date DATE NOT NULL,
  target_end_date DATE NOT NULL,
  ended_reason ENUM('replaced', 'removed') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE
);
ALTER TABLE users ADD COLUMN push_token VARCHAR(255) DEFAULT NULL;

CREATE TABLE payout_rotation_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  cycle_number INT NOT NULL,
  user_id INT NOT NULL,
  rotation_order INT NOT NULL,
  has_received BOOLEAN NOT NULL,
  received_at DATETIME DEFAULT NULL,
  amount DECIMAL(10,2) DEFAULT NULL,
  archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE loans
  ADD COLUMN last_reminded_at DATETIME DEFAULT NULL,
  ADD COLUMN reminder_count INT NOT NULL DEFAULT 0;

  ALTER TABLE groups_table ADD COLUMN last_cycle_announced VARCHAR(10) DEFAULT NULL;
  
  CREATE TABLE contribution_reminders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  user_id INT NOT NULL,
  cycle_period VARCHAR(20) NOT NULL,
  sent_by INT NULL,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_reminder_lookup (group_id, user_id, cycle_period, sent_at),
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE request_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  idempotency_key VARCHAR(64) NOT NULL,
  user_id INT NOT NULL,
  endpoint VARCHAR(40) NOT NULL,
  response_json TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_request_key (idempotency_key, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE groups_table ADD COLUMN last_due_soon_cycle VARCHAR(20) DEFAULT NULL;

ALTER TABLE groups_table
  ADD COLUMN late_interest_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN late_interest_period ENUM('weekly','monthly') NOT NULL DEFAULT 'monthly',
  ADD COLUMN late_interest_grace_days INT NOT NULL DEFAULT 0,
  ADD COLUMN late_interest_cap_percent DECIMAL(5,2) NOT NULL DEFAULT 50;

ALTER TABLE loans
  ADD COLUMN interest_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN interest_period ENUM('weekly','monthly') NOT NULL DEFAULT 'monthly',
  ADD COLUMN interest_grace_days INT NOT NULL DEFAULT 0,
  ADD COLUMN interest_cap_percent DECIMAL(5,2) NOT NULL DEFAULT 50;

ALTER TABLE loan_repayments
  ADD COLUMN interest_portion DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN principal_portion DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Repayments made before this feature were all principal
UPDATE loan_repayments SET principal_portion = amount_paid
WHERE interest_portion = 0 AND principal_portion = 0;

CREATE TABLE loan_interest_charges (
  id INT AUTO_INCREMENT PRIMARY KEY,
  loan_id INT NOT NULL,
  period_number INT NOT NULL,
  charged_on DATE NOT NULL,
  base_amount DECIMAL(10,2) NOT NULL,
  rate DECIMAL(5,2) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_loan_period (loan_id, period_number),
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mpesa_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  group_id INT NOT NULL,
  purpose ENUM('contribution', 'savings', 'loan_repayment') NOT NULL,
  reference_id INT DEFAULT NULL,              -- loan id when purpose = 'loan_repayment'
  amount DECIMAL(10,2) NOT NULL,
  phone VARCHAR(15) NOT NULL,                 -- 2547XXXXXXXX
  note VARCHAR(255) DEFAULT NULL,             -- optional savings note
  merchant_request_id VARCHAR(64) DEFAULT NULL,
  checkout_request_id VARCHAR(64) DEFAULT NULL,
  status ENUM('pending', 'success', 'failed', 'cancelled') NOT NULL DEFAULT 'pending',
  result_code INT DEFAULT NULL,
  result_desc VARCHAR(255) DEFAULT NULL,
  mpesa_receipt VARCHAR(32) DEFAULT NULL,
  fulfilled TINYINT(1) NOT NULL DEFAULT 0,    -- 1 once the contribution / saving / repayment row has been created
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_checkout (checkout_request_id),
  UNIQUE KEY uq_receipt (mpesa_receipt),
  INDEX idx_user_status (user_id, status),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE
);
ALTER TABLE mpesa_transactions ADD COLUMN fulfil_error VARCHAR(255) DEFAULT NULL AFTER fulfilled;

-- M-Pesa B2C (money out): payouts and loan disbursements
-- Run in phpMyAdmin, then append this block to migrations/migrations.sql so the schema stays in one place.

CREATE TABLE IF NOT EXISTS mpesa_b2c_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  purpose ENUM('payout', 'loan_disbursement') NOT NULL,
  group_id INT NOT NULL,
  user_id INT NOT NULL,                       -- who receives the money
  reference_id INT NOT NULL,                  -- payout_rotations.id or loans.id
  amount DECIMAL(10,2) NOT NULL,              -- whole shillings, as sent to M-Pesa
  phone VARCHAR(15) NOT NULL,                 -- 2547XXXXXXXX
  initiated_by INT NOT NULL,                  -- the treasurer / chair who pressed send
  request_ref VARCHAR(36) NOT NULL,           -- our own unique id for this attempt
  originator_conversation_id VARCHAR(64) DEFAULT NULL,
  conversation_id VARCHAR(64) DEFAULT NULL,
  status ENUM('pending', 'success', 'failed', 'timeout') NOT NULL DEFAULT 'pending',
  result_code INT DEFAULT NULL,
  result_desc VARCHAR(255) DEFAULT NULL,
  mpesa_receipt VARCHAR(32) DEFAULT NULL,
  receiver_name VARCHAR(100) DEFAULT NULL,
  fulfilled TINYINT(1) NOT NULL DEFAULT 0,    -- 1 once the payout / loan has been marked as paid out
  fulfil_error VARCHAR(255) DEFAULT NULL,     -- why marking it failed, so a paid-out transfer is never silently lost
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_b2c_request_ref (request_ref),
  UNIQUE KEY uq_b2c_receipt (mpesa_receipt),
  INDEX idx_b2c_conversation (conversation_id),
  INDEX idx_b2c_originator (originator_conversation_id),
  INDEX idx_b2c_reference (purpose, reference_id, status),
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (initiated_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Loans paid out through M-Pesa remember when and with which receipt
ALTER TABLE loans
  ADD COLUMN disbursed_at DATETIME DEFAULT NULL,
  ADD COLUMN disbursement_receipt VARCHAR(32) DEFAULT NULL;

  -- Second approver for payouts
-- Run in phpMyAdmin BEFORE replacing the backend files, then append this block to migrations/migrations.sql.

CREATE TABLE IF NOT EXISTS payout_approvals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  rotation_id INT NOT NULL,                   -- payout_rotations.id of the turn. No foreign key on purpose: starting a new cycle
                                              -- deletes the old rotation rows, and the approval history must survive that.
  recipient_id INT NOT NULL,                  -- who is being paid
  amount DECIMAL(10,2) NOT NULL,              -- the amount the approver saw. If the payout amount changes later, the approval no longer counts.
  requested_by INT NOT NULL,                  -- the treasurer / chair who asked
  status ENUM('requested', 'approved', 'rejected', 'cancelled', 'used') NOT NULL DEFAULT 'requested',
  decided_by INT DEFAULT NULL,                -- the second treasurer / chair who approved or rejected
  decided_at DATETIME DEFAULT NULL,
  used_at DATETIME DEFAULT NULL,              -- when the approved payout was actually paid out
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pa_rotation (rotation_id, status),
  INDEX idx_pa_group (group_id, status),
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Cash payments need confirmation
-- A member says "I paid KES X in cash to <treasurer/chair>". Nothing is recorded until that person confirms.
-- Run in phpMyAdmin BEFORE replacing the backend files, then append this block to migrations/migrations.sql.

CREATE TABLE IF NOT EXISTS cash_claims (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  user_id INT NOT NULL,                       -- the member who says they paid
  kind ENUM('contribution', 'loan_repayment') NOT NULL,
  loan_id INT DEFAULT NULL,                   -- set for loan repayments
  claimed_amount DECIMAL(10,2) NOT NULL,      -- what the member says they handed over
  confirmed_amount DECIMAL(10,2) DEFAULT NULL,-- what the receiver says they actually got (can be less than claimed)
  receiver_id INT NOT NULL,                   -- the treasurer / chair the money was handed to; only they can confirm
  status ENUM('pending', 'confirmed', 'rejected', 'cancelled') NOT NULL DEFAULT 'pending',
  reject_reason VARCHAR(255) DEFAULT NULL,
  decided_by INT DEFAULT NULL,
  decided_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cc_group (group_id, status),
  INDEX idx_cc_user (user_id, status),
  INDEX idx_cc_receiver (receiver_id, status),
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
  FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Only needed if you ALREADY ran cash_claims_migration.sql before this change.
-- (A fresh install of the updated cash_claims_migration.sql already has this column.)
-- Run in phpMyAdmin BEFORE replacing the backend files, then append to migrations/migrations.sql.

ALTER TABLE cash_claims
  ADD COLUMN IF NOT EXISTS dismissed_by_payer TINYINT(1) NOT NULL DEFAULT 0 AFTER reject_reason;

  -- Secretary tools: meetings, attendance, minutes and group notices
-- Run in phpMyAdmin BEFORE replacing the backend files, then append this block to migrations/migrations.sql.
-- (The 'secretary' role already exists in group_members.role, so nothing to change there.)

CREATE TABLE IF NOT EXISTS meetings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  title VARCHAR(120) NOT NULL,
  meeting_date DATETIME NOT NULL,
  venue VARCHAR(150) DEFAULT NULL,
  agenda TEXT DEFAULT NULL,
  minutes MEDIUMTEXT DEFAULT NULL,
  minutes_updated_at DATETIME DEFAULT NULL,
  status ENUM('scheduled', 'held', 'cancelled') NOT NULL DEFAULT 'scheduled',
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_meetings_group (group_id, meeting_date),
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS meeting_attendance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meeting_id INT NOT NULL,
  user_id INT NOT NULL,
  status ENUM('present', 'apology', 'absent') NOT NULL,
  marked_by INT DEFAULT NULL,                 -- the secretary / chair who marked it, or the member themself for an apology
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_attendance (meeting_id, user_id),
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (marked_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS announcements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  title VARCHAR(120) NOT NULL,
  body TEXT NOT NULL,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_announcements_group (group_id, created_at),
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);