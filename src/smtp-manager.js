const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const fs = require('fs');
const path = require('path');

function buildTransport(account) {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    ignoreTLS: !!account.smtp.ignoreTLS,
    auth: { user: account.username || account.email, pass: account.password },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    tls: { minVersion: 'TLSv1.2' },
  });
}

function buildMailOptions(account, { to, cc, bcc, subject, text, html, attachments, inReplyTo, references, messageId }) {
  const mailOptions = {
    // Object form lets nodemailer quote/encode names containing commas, umlauts, etc.
    from: { name: account.name || '', address: account.email },
    to,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject,
    text: text || '',
    // Plain-text mode sends no HTML part (wrapping text as HTML would collapse line breaks)
    html: html || undefined,
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
    messageId: messageId || undefined,
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
  return mailOptions;
}

async function sendEmail(account, data) {
  const transport = buildTransport(account);
  try {
    const info = await transport.sendMail(buildMailOptions(account, data));
    return { success: true, messageId: info.messageId };
  } finally {
    transport.close();
  }
}

/** RFC 822 source of a message (for IMAP APPEND, e.g. drafts). Bcc is kept, like other clients do for drafts. */
function buildRaw(account, data) {
  const mail = new MailComposer(buildMailOptions(account, data)).compile();
  mail.keepBcc = true;
  return mail.build();
}

async function testSmtp(account) {
  const transport = buildTransport(account);
  try {
    await transport.verify();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    transport.close();
  }
}

module.exports = { sendEmail, testSmtp, buildRaw };
