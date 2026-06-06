const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

function buildTransport(account) {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.email, pass: account.password },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    tls: { minVersion: 'TLSv1.2' },
  });
}

async function sendEmail(account, { to, cc, bcc, subject, text, html, attachments }) {
  const transport = buildTransport(account);
  try {
    const mailOptions = {
      from: `${account.name} <${account.email}>`,
      to,
      cc: cc || undefined,
      bcc: bcc || undefined,
      subject,
      text: text || '',
      html: html || text || '',
    };

    if (attachments?.length) {
      mailOptions.attachments = attachments.map(a => {
        const resolved = path.resolve(a.path);
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) throw new Error(`Attachment is not a regular file: ${a.name}`);
        return {
          filename: a.name,
          contentType: a.type || 'application/octet-stream',
          content: fs.readFileSync(resolved),
        };
      });
    }

    const info = await transport.sendMail(mailOptions);
    return { success: true, messageId: info.messageId };
  } finally {
    transport.close();
  }
}

async function testSmtp(account) {
  const transport = buildTransport(account);
  try {
    await transport.verify();
    transport.close();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { sendEmail, testSmtp };
