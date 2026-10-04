-- Test users (password_hash is just a placeholder for now — we'll wire up real bcrypt hashing when we build the auth routes)
INSERT INTO users (full_name, email, phone, password_hash) VALUES
('Victor Otieno', 'victor@example.com', '0712345678', 'placeholder_hash'),
('Mary Wanjiru', 'mary@example.com', '0722345678', 'placeholder_hash'),
('James Kariuki', 'james@example.com', '0733345678', 'placeholder_hash');

-- Test group
INSERT INTO groups_table (name, description, contribution_amount, contribution_frequency, created_by) VALUES
('Umoja Chama', 'Monthly savings group for tech professionals', 2000.00, 'monthly', 1);

-- Add all three as members, different roles
INSERT INTO group_members (group_id, user_id, role) VALUES
(1, 1, 'treasurer'),
(1, 2, 'chair'),
(1, 3, 'member');

-- A couple of contributions
INSERT INTO contributions (group_id, user_id, amount, cycle_period, status, paid_at) VALUES
(1, 1, 2000.00, '2026-08', 'paid', '2026-08-05 10:00:00'),
(1, 2, 2000.00, '2026-08', 'paid', '2026-08-06 14:00:00'),
(1, 3, 2000.00, '2026-08', 'pending', NULL);

-- A loan request
INSERT INTO loans (group_id, user_id, amount, status) VALUES
(1, 3, 5000.00, 'requested');