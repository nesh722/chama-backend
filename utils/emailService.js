const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

exports.sendPasswordResetEmail = async (toEmail, resetToken) => {
  const mailOptions = {
    from: `"Chama App" <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: 'Password Reset Request',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Reset Your Password</h2>
        <p>You requested a password reset for your Chama account.</p>
        <p>Use the code below in the app to set a new password:</p>
        <p style="font-size: 20px; font-weight: bold; background: #f3f4f6; padding: 12px; border-radius: 8px; text-align: center; letter-spacing: 1px; word-break: break-all;">
          ${resetToken}
        </p>
        <p style="color: #888; font-size: 13px;">This code expires in 30 minutes. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
};