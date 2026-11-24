-- =====================================================================
-- Chama Savings Management App: full database schema
-- Generated from the live chama_db (MariaDB 10.4) on 2026-11-15.
-- Run on an EMPTY database:  CREATE DATABASE chama_db; USE chama_db;  then run this file.
-- Tables are created first, then foreign keys are added (so order never matters).
-- =====================================================================

SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS `activity_log` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `group_id` int(11) DEFAULT NULL,
  `action_type` varchar(50) NOT NULL,
  `description` text NOT NULL,
  `amount` decimal(10,2) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `group_id` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `announcements` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `title` varchar(120) NOT NULL,
  `body` text NOT NULL,
  `created_by` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_announcements_group` (`group_id`,`created_at`),
  KEY `created_by` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `cash_claims` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `kind` enum('contribution','loan_repayment','extra_savings') NOT NULL,
  `loan_id` int(11) DEFAULT NULL,
  `claimed_amount` decimal(10,2) NOT NULL,
  `confirmed_amount` decimal(10,2) DEFAULT NULL,
  `receiver_id` int(11) NOT NULL,
  `status` enum('pending','confirmed','rejected','cancelled') NOT NULL DEFAULT 'pending',
  `reject_reason` varchar(255) DEFAULT NULL,
  `note` varchar(255) DEFAULT NULL,
  `dismissed_by_payer` tinyint(1) NOT NULL DEFAULT 0,
  `decided_by` int(11) DEFAULT NULL,
  `decided_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_cc_group` (`group_id`,`status`),
  KEY `idx_cc_user` (`user_id`,`status`),
  KEY `idx_cc_receiver` (`receiver_id`,`status`),
  KEY `loan_id` (`loan_id`),
  KEY `decided_by` (`decided_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `contributions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `cycle_period` varchar(20) NOT NULL,
  `status` enum('pending','paid','late','partial') NOT NULL DEFAULT 'pending',
  `paid_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `group_id` (`group_id`),
  KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `contribution_reminders` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `cycle_period` varchar(20) NOT NULL,
  `sent_by` int(11) DEFAULT NULL,
  `sent_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_reminder_lookup` (`group_id`,`user_id`,`cycle_period`,`sent_at`),
  KEY `user_id` (`user_id`),
  KEY `sent_by` (`sent_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `groups_table` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `invite_token` varchar(32) DEFAULT NULL,
  `name` varchar(150) NOT NULL,
  `description` text DEFAULT NULL,
  `contribution_amount` decimal(12,2) NOT NULL,
  `contribution_frequency` enum('weekly','monthly') NOT NULL DEFAULT 'monthly',
  `created_by` int(11) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `savings_target` decimal(12,2) DEFAULT NULL,
  `target_start_date` date DEFAULT NULL,
  `last_cycle_announced` varchar(10) DEFAULT NULL,
  `cycle_anchor_date` date DEFAULT NULL,
  `last_due_soon_cycle` varchar(20) DEFAULT NULL,
  `late_interest_rate` decimal(5,2) NOT NULL DEFAULT 0.00,
  `late_interest_period` enum('weekly','monthly') NOT NULL DEFAULT 'monthly',
  `late_interest_grace_days` int(11) NOT NULL DEFAULT 0,
  `late_interest_cap_percent` decimal(5,2) NOT NULL DEFAULT 50.00,
  PRIMARY KEY (`id`),
  UNIQUE KEY `invite_token` (`invite_token`),
  KEY `created_by` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `group_members` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `role` enum('chair','treasurer','secretary','member') NOT NULL DEFAULT 'member',
  `joined_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_membership` (`group_id`,`user_id`),
  KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `loans` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `due_date` date DEFAULT NULL,
  `overdue_notified` tinyint(1) NOT NULL DEFAULT 0,
  `status` enum('requested','approved','rejected','repaid') NOT NULL DEFAULT 'requested',
  `requested_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `approved_at` timestamp NULL DEFAULT NULL,
  `approved_by` int(11) DEFAULT NULL,
  `last_reminded_at` datetime DEFAULT NULL,
  `reminder_count` int(11) NOT NULL DEFAULT 0,
  `interest_rate` decimal(5,2) NOT NULL DEFAULT 0.00,
  `interest_period` enum('weekly','monthly') NOT NULL DEFAULT 'monthly',
  `interest_grace_days` int(11) NOT NULL DEFAULT 0,
  `interest_cap_percent` decimal(5,2) NOT NULL DEFAULT 50.00,
  `disbursed_at` datetime DEFAULT NULL,
  `disbursement_receipt` varchar(32) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `group_id` (`group_id`),
  KEY `user_id` (`user_id`),
  KEY `approved_by` (`approved_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `loan_interest_charges` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `loan_id` int(11) NOT NULL,
  `period_number` int(11) NOT NULL,
  `charged_on` date NOT NULL,
  `base_amount` decimal(10,2) NOT NULL,
  `rate` decimal(5,2) NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_loan_period` (`loan_id`,`period_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `loan_repayments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `loan_id` int(11) NOT NULL,
  `amount_paid` decimal(12,2) NOT NULL,
  `paid_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `interest_portion` decimal(10,2) NOT NULL DEFAULT 0.00,
  `principal_portion` decimal(10,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (`id`),
  KEY `loan_id` (`loan_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `meetings` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `title` varchar(120) NOT NULL,
  `meeting_date` datetime NOT NULL,
  `venue` varchar(150) DEFAULT NULL,
  `agenda` text DEFAULT NULL,
  `minutes` mediumtext DEFAULT NULL,
  `minutes_updated_at` datetime DEFAULT NULL,
  `status` enum('scheduled','held','cancelled') NOT NULL DEFAULT 'scheduled',
  `created_by` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_meetings_group` (`group_id`,`meeting_date`),
  KEY `created_by` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `meeting_attendance` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `meeting_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `status` enum('present','apology','absent') NOT NULL,
  `reason` varchar(255) DEFAULT NULL,
  `marked_by` int(11) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_attendance` (`meeting_id`,`user_id`),
  KEY `user_id` (`user_id`),
  KEY `marked_by` (`marked_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `mpesa_b2c_transactions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `purpose` enum('payout','loan_disbursement') NOT NULL,
  `group_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `reference_id` int(11) NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `phone` varchar(15) NOT NULL,
  `initiated_by` int(11) NOT NULL,
  `request_ref` varchar(36) NOT NULL,
  `originator_conversation_id` varchar(64) DEFAULT NULL,
  `conversation_id` varchar(64) DEFAULT NULL,
  `status` enum('pending','success','failed','timeout') NOT NULL DEFAULT 'pending',
  `result_code` int(11) DEFAULT NULL,
  `result_desc` varchar(255) DEFAULT NULL,
  `mpesa_receipt` varchar(32) DEFAULT NULL,
  `receiver_name` varchar(100) DEFAULT NULL,
  `fulfilled` tinyint(1) NOT NULL DEFAULT 0,
  `fulfil_error` varchar(255) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_b2c_request_ref` (`request_ref`),
  UNIQUE KEY `uq_b2c_receipt` (`mpesa_receipt`),
  KEY `idx_b2c_conversation` (`conversation_id`),
  KEY `idx_b2c_originator` (`originator_conversation_id`),
  KEY `idx_b2c_reference` (`purpose`,`reference_id`,`status`),
  KEY `group_id` (`group_id`),
  KEY `user_id` (`user_id`),
  KEY `initiated_by` (`initiated_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `mpesa_transactions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `group_id` int(11) NOT NULL,
  `purpose` enum('contribution','savings','loan_repayment') NOT NULL,
  `reference_id` int(11) DEFAULT NULL,
  `amount` decimal(10,2) NOT NULL,
  `phone` varchar(15) NOT NULL,
  `note` varchar(255) DEFAULT NULL,
  `merchant_request_id` varchar(64) DEFAULT NULL,
  `checkout_request_id` varchar(64) DEFAULT NULL,
  `status` enum('pending','success','failed','cancelled') NOT NULL DEFAULT 'pending',
  `result_code` int(11) DEFAULT NULL,
  `result_desc` varchar(255) DEFAULT NULL,
  `mpesa_receipt` varchar(32) DEFAULT NULL,
  `fulfilled` tinyint(1) NOT NULL DEFAULT 0,
  `fulfil_error` varchar(255) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_checkout` (`checkout_request_id`),
  UNIQUE KEY `uq_receipt` (`mpesa_receipt`),
  KEY `idx_user_status` (`user_id`,`status`),
  KEY `group_id` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `notifications` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `group_id` int(11) DEFAULT NULL,
  `title` varchar(150) NOT NULL,
  `message` text NOT NULL,
  `is_read` tinyint(1) DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `password_resets` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `token` varchar(255) NOT NULL,
  `expires_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `used` tinyint(1) DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `payout_approvals` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `rotation_id` int(11) NOT NULL,
  `recipient_id` int(11) NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `requested_by` int(11) NOT NULL,
  `status` enum('requested','approved','rejected','cancelled','used') NOT NULL DEFAULT 'requested',
  `decided_by` int(11) DEFAULT NULL,
  `decided_at` datetime DEFAULT NULL,
  `used_at` datetime DEFAULT NULL,
  `requested_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_pa_rotation` (`rotation_id`,`status`),
  KEY `idx_pa_group` (`group_id`,`status`),
  KEY `recipient_id` (`recipient_id`),
  KEY `requested_by` (`requested_by`),
  KEY `decided_by` (`decided_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `payout_rotations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `rotation_order` int(11) NOT NULL,
  `has_received` tinyint(1) DEFAULT 0,
  `received_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `group_id` (`group_id`),
  KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `payout_rotation_history` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `cycle_number` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `rotation_order` int(11) NOT NULL,
  `has_received` tinyint(1) NOT NULL,
  `received_at` datetime DEFAULT NULL,
  `amount` decimal(10,2) DEFAULT NULL,
  `archived_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `group_id` (`group_id`),
  KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `request_keys` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `idempotency_key` varchar(64) NOT NULL,
  `user_id` int(11) NOT NULL,
  `endpoint` varchar(40) NOT NULL,
  `response_json` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_request_key` (`idempotency_key`,`user_id`),
  KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `savings_deposits` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `note` varchar(255) DEFAULT NULL,
  `deposited_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `group_id` (`group_id`),
  KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `savings_target_history` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `savings_target` decimal(10,2) NOT NULL,
  `target_start_date` date NOT NULL,
  `target_end_date` date NOT NULL,
  `ended_reason` enum('replaced','removed') NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `group_id` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `transactions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `type` enum('contribution','loan_disbursement','loan_repayment','payout','savings') NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `reference_id` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `group_id` (`group_id`),
  KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `full_name` varchar(150) NOT NULL,
  `email` varchar(150) NOT NULL,
  `phone` varchar(20) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `avatar_url` varchar(255) DEFAULT NULL,
  `push_token` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  UNIQUE KEY `phone` (`phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Foreign keys

ALTER TABLE `activity_log`
  ADD CONSTRAINT `activity_log_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `activity_log_ibfk_2` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE SET NULL;

ALTER TABLE `announcements`
  ADD CONSTRAINT `announcements_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `announcements_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `cash_claims`
  ADD CONSTRAINT `cash_claims_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `cash_claims_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `cash_claims_ibfk_3` FOREIGN KEY (`receiver_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `cash_claims_ibfk_4` FOREIGN KEY (`loan_id`) REFERENCES `loans` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `cash_claims_ibfk_5` FOREIGN KEY (`decided_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `contributions`
  ADD CONSTRAINT `contributions_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `contributions_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

ALTER TABLE `contribution_reminders`
  ADD CONSTRAINT `contribution_reminders_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `contribution_reminders_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `contribution_reminders_ibfk_3` FOREIGN KEY (`sent_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `groups_table`
  ADD CONSTRAINT `groups_table_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

ALTER TABLE `group_members`
  ADD CONSTRAINT `group_members_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `group_members_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

ALTER TABLE `loans`
  ADD CONSTRAINT `loans_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `loans_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `loans_ibfk_3` FOREIGN KEY (`approved_by`) REFERENCES `users` (`id`);

ALTER TABLE `loan_interest_charges`
  ADD CONSTRAINT `loan_interest_charges_ibfk_1` FOREIGN KEY (`loan_id`) REFERENCES `loans` (`id`) ON DELETE CASCADE;

ALTER TABLE `loan_repayments`
  ADD CONSTRAINT `loan_repayments_ibfk_1` FOREIGN KEY (`loan_id`) REFERENCES `loans` (`id`) ON DELETE CASCADE;

ALTER TABLE `meetings`
  ADD CONSTRAINT `meetings_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `meetings_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `meeting_attendance`
  ADD CONSTRAINT `meeting_attendance_ibfk_1` FOREIGN KEY (`meeting_id`) REFERENCES `meetings` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `meeting_attendance_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `meeting_attendance_ibfk_3` FOREIGN KEY (`marked_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `mpesa_b2c_transactions`
  ADD CONSTRAINT `mpesa_b2c_transactions_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `mpesa_b2c_transactions_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `mpesa_b2c_transactions_ibfk_3` FOREIGN KEY (`initiated_by`) REFERENCES `users` (`id`) ON DELETE CASCADE;

ALTER TABLE `mpesa_transactions`
  ADD CONSTRAINT `mpesa_transactions_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `mpesa_transactions_ibfk_2` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE;

ALTER TABLE `notifications`
  ADD CONSTRAINT `notifications_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

ALTER TABLE `password_resets`
  ADD CONSTRAINT `password_resets_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

ALTER TABLE `payout_approvals`
  ADD CONSTRAINT `payout_approvals_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `payout_approvals_ibfk_2` FOREIGN KEY (`recipient_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `payout_approvals_ibfk_3` FOREIGN KEY (`requested_by`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `payout_approvals_ibfk_4` FOREIGN KEY (`decided_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `payout_rotations`
  ADD CONSTRAINT `payout_rotations_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `payout_rotations_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

ALTER TABLE `payout_rotation_history`
  ADD CONSTRAINT `payout_rotation_history_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `payout_rotation_history_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

ALTER TABLE `request_keys`
  ADD CONSTRAINT `request_keys_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

ALTER TABLE `savings_deposits`
  ADD CONSTRAINT `savings_deposits_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `savings_deposits_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

ALTER TABLE `savings_target_history`
  ADD CONSTRAINT `savings_target_history_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE;

ALTER TABLE `transactions`
  ADD CONSTRAINT `transactions_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups_table` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `transactions_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

SET FOREIGN_KEY_CHECKS = 1;