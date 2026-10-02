export interface EmailContent {
  subject: string;
  text: string;
  html?: string;
}

export interface LinkEmailContext {
  appName: string;
  email: string;
  /** Link containing the single-use token. */
  url: string;
  /** Minutes until the link expires. */
  expiresInMinutes: number;
}

export interface LockoutEmailContext {
  appName: string;
  email: string;
  lockedUntil: Date;
}

export interface EmailChangeNoticeContext {
  appName: string;
  email: string;
  newEmail: string;
}

/** Overridable email templates. Categories: auth.password-reset, auth.email-verification, auth.lockout, auth.email-change. */
export interface AuthEmailTemplates {
  passwordReset(ctx: LinkEmailContext): EmailContent;
  emailVerification(ctx: LinkEmailContext): EmailContent;
  emailChange(ctx: LinkEmailContext): EmailContent;
  emailChangeNotice(ctx: EmailChangeNoticeContext): EmailContent;
  lockout(ctx: LockoutEmailContext): EmailContent;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const linkHtml = (intro: string, url: string, outro: string) =>
  `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>${escapeHtml(outro)}</p>`;

export const defaultEmailTemplates: AuthEmailTemplates = {
  passwordReset: ({ appName, url, expiresInMinutes }) => {
    const intro = `We received a request to reset your ${appName} password. Use this link to choose a new password:`;
    const outro = `The link expires in ${expiresInMinutes} minutes and can be used once. If you did not request a reset, you can ignore this email.`;
    return {
      subject: `Reset your ${appName} password`,
      text: `${intro}\n\n${url}\n\n${outro}\n`,
      html: linkHtml(intro, url, outro),
    };
  },
  emailVerification: ({ appName, url, expiresInMinutes }) => {
    const intro = `Confirm your email address for ${appName}:`;
    const outro = `The link expires in ${expiresInMinutes} minutes. If you did not create an account, you can ignore this email.`;
    return {
      subject: `Confirm your email for ${appName}`,
      text: `${intro}\n\n${url}\n\n${outro}\n`,
      html: linkHtml(intro, url, outro),
    };
  },
  emailChange: ({ appName, url, expiresInMinutes }) => {
    const intro = `Confirm this address as the new email for your ${appName} account:`;
    const outro = `The link expires in ${expiresInMinutes} minutes. If you did not request this change, you can ignore this email.`;
    return {
      subject: `Confirm your new email for ${appName}`,
      text: `${intro}\n\n${url}\n\n${outro}\n`,
      html: linkHtml(intro, url, outro),
    };
  },
  emailChangeNotice: ({ appName, newEmail }) => {
    const text = `A request was made to change the email address of your ${appName} account to ${newEmail}. The change takes effect only after the new address is confirmed. If this was not you, reset your password and review your active sessions.`;
    return {
      subject: `Email change requested for ${appName}`,
      text: `${text}\n`,
      html: `<p>${escapeHtml(text)}</p>`,
    };
  },
  lockout: ({ appName, lockedUntil }) => {
    const text = `Your ${appName} account was temporarily locked after repeated failed sign-in attempts. It unlocks automatically at ${lockedUntil.toISOString()}. If these attempts were not you, reset your password.`;
    return {
      subject: `${appName} account temporarily locked`,
      text: `${text}\n`,
      html: `<p>${escapeHtml(text)}</p>`,
    };
  },
};
