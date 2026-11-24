// Emails for two-step login codes and account lockouts.
// !! Match these two names to the ones your utils/emailService.js already uses for the Gmail login !!
const nodemailer = require('nodemailer');

const MAIL_USER = process.env.EMAIL_USER;
const MAIL_PASS = process.env.EMAIL_PASS;

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: MAIL_USER, pass: MAIL_PASS }
});

async function send(to, subject, text) {
  await transporter.sendMail({ from: `"Chama App" <${MAIL_USER}>`, to, subject, text });
}

exports.sendLoginCode = (to, code, minutes, why) =>
  send(
    to,
    `Your Chama App code: ${code}`,
    `Your Chama App code is ${code}.\n\nIt is for ${why} and works for ${minutes} minutes. ` +
      `If you did not ask for it, someone may know your password: change it now and do not share this code.`
  );

exports.sendLockoutNotice = (to, minutes) =>
  send(
    to,
    'Your Chama App account was locked',
    `There were too many wrong password attempts on your Chama App account, so it is locked for ${minutes} minutes.\n\n` +
      `If this was you, wait and try again, or reset your password from the login screen. ` +
      `If it was not you, reset your password now.`
  );
