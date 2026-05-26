const nodemailer = require('nodemailer');
const fs = require('fs');

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
    mailOptions.attachments = attachments.map(a => ({
      filename: a.name,
      contentType: a.type || 'application/octet-stream',
      content: fs.readFileSync(a.path),
    }));
  }

  const info = await transport.sendMail(mailOptions);
  transport.close();
  return { success: true, messageId: info.messageId };
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
