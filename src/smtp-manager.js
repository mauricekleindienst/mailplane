const nodemailer = require('nodemailer');

async function sendEmail(account, { to, cc, subject, text, html }) {
  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.email, pass: account.password },
  });

  const info = await transport.sendMail({
    from: `${account.name} <${account.email}>`,
    to,
    cc: cc || undefined,
    subject,
    text: text || '',
    html: html || text || '',
  });

  transport.close();
  return { success: true, messageId: info.messageId };
}

async function testSmtp(account) {
  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.email, pass: account.password },
    connectionTimeout: 10000,
  });
  try {
    await transport.verify();
    transport.close();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { sendEmail, testSmtp };
