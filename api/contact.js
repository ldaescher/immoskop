import nodemailer from 'nodemailer';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, betreff, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'Fehlende Felder' });

  const transporter = nodemailer.createTransport({
    host: 'smtp.protonmail.ch',
    port: 587,
    secure: false,
    auth: {
      user: process.env.PROTONMAIL_USER,
      pass: process.env.PROTONMAIL_TOKEN,
    },
  });

  try {
    await transporter.sendMail({
      from: '"Immoskop Kontakt" <hello@immoskop.ch>',
      to: 'hello@immoskop.ch',
      replyTo: `${name} <${email}>`,
      subject: `Immoskop Kontakt: ${betreff || 'Nachricht'}`,
      text: `Name: ${name}\nE-Mail: ${email}\nBetreff: ${betreff || '–'}\n\n${message}`,
      html: `<p><strong>Name:</strong> ${name}</p><p><strong>E-Mail:</strong> ${email}</p><p><strong>Betreff:</strong> ${betreff || '–'}</p><hr><p>${message.replace(/\n/g,'<br>')}</p>`,
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('SMTP error:', e.message);
    return res.status(500).json({ error: 'Sendefehler: ' + e.message });
  }
}
