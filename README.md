# Chama Savings Management App — Backend

REST API backend for the Chama Savings Management App — handles authentication, group management, contributions, loans, payout rotations, savings targets, reporting, and notifications, with role-based business rules enforced server-side.

Built as a 4th-year Computer Science final year project.

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express
- **Database:** MySQL (raw SQL via `mysql2`, no ORM)
- **Auth:** JWT (`jsonwebtoken`) + `bcrypt` for password hashing
- **Email:** `nodemailer` (Gmail SMTP App Password) — real emailed password reset codes
- **File uploads:** `multer` (profile picture avatars)
- **PDF generation:** `pdfkit` (report exports)
- **Dev tooling:** `nodemon`, `dotenv`

## Project Structure

```
config/           # Database connection config
controllers/      # Request handlers, grouped by domain
middleware/        # Auth middleware, etc.
migrations/        # Database schema migrations
seeders/           # Seed data for development/testing
routes/            # Express route definitions, mounted in index.js
uploads/
└── avatars/       # Uploaded profile pictures (served statically)
utils/             # Shared helpers (activity logging, email service)
```

## Core Domains

| Domain | Routes mounted at | Covers |
|---|---|---|
| Auth | `/api/auth` | Register, login, password reset, profile, avatar upload, account deletion |
| Groups | `/api/groups` | Create/join (by ID or invite token/QR), role management, member removal, group deletion |
| Contributions | `/api/contributions` | Logging contributions, cycle tracking, defaulters |
| Loans | `/api/loans` | Request, approve/reject, repay, due dates, overdue detection |
| Payouts | `/api/payouts` | Rotation setup, mark-next-payout |
| Savings | `/api/savings` | Savings target, Extra Savings deposits, progress tracking |
| Notifications | `/api/notifications` | In-app notifications, mark-as-read, clear-all |
| Activity | `/api/activity` | Personal activity history log |
| Reports | `/api/reports` | Role-scoped reports (contributions, loans, payouts, savings target, full summary) with CSV/PDF export |

## Key Business Rules (enforced server-side)

- A requester cannot approve/reject their own loan request
- Only treasurer/chair roles can approve loans, change member roles, remove members, or set savings targets
- A group needs at least 2 potential approvers before loans can be requested in it
- A group can never be left with zero treasurer/chair members
- Only one outstanding loan per member per group at a time
- Account deletion is blocked while the user has outstanding loans, is the sole treasurer/chair of any group, or has created a group that still exists
- Reports are scoped by role: members see only their own data, treasurer/chair see the full group

## Getting Started

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Set up environment variables**

   Create a `.env` file in the project root:
   ```
   PORT=5000
   DB_HOST=localhost
   DB_USER=your_mysql_user
   DB_PASSWORD=your_mysql_password
   DB_NAME=chama_app
   DB_PORT=3306
   JWT_SECRET=your_jwt_secret
   EMAIL_USER=your_gmail_address
   EMAIL_APP_PASSWORD=your_gmail_app_password
   ```
   The `DB_*` variables are confirmed against `config/db.js`. The `EMAIL_*` names are a best guess based on the "Nodemailer + Gmail SMTP App Password" setup described in the project status report — confirm these against `utils/emailService.js` and adjust if they differ.

3. **Set up the database**

   Create a MySQL database matching `DB_NAME`. The SQL files in `migrations/` are not run by a migration tool — open them and run each one manually against your database (e.g. via phpMyAdmin's SQL tab), in order. The `seeders/` folder contains optional sample data you can run the same way.

4. **Start the server**
   ```bash
   npm run dev
   ```
   (uses `nodemon` for auto-reload) or `npm start` for a plain start (both run `server.js`).

   The API will be running at `http://localhost:5000`. Confirm it's up:
   ```
   GET http://localhost:5000/
   GET http://localhost:5000/api/test-db
   ```

5. **Point the mobile app at this backend**

   In the mobile app's `src/config/api.js`, set `API_BASE_URL` to this machine's local network IP (e.g. `http://192.168.x.x:5000/api`) rather than `localhost`, since Expo Go on a physical device can't resolve `localhost` as your dev machine.

## Known Limitations / Technical Debt

- No rate-limiting on password reset requests
- A legacy join-by-numeric-group-ID endpoint still exists but is unused in the current UI, which now uses QR/invite-token joining exclusively

## Roadmap

- [ ] Rate-limit password reset requests
- [ ] Broader test coverage for recently added features (QR invites, loan due dates, Extra Savings, Reports)
- [ ] Project documentation (SRS, ERD, architecture diagrams, testing chapter)