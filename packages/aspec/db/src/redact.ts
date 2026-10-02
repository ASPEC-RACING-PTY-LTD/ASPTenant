const REDACTED = '***';

// scheme://user:password@host  ->  scheme://user:***@host
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^:/?#\s@]*:)([^@\s]*)@/gi;
// password=secret in query strings and key/value connection strings
const PASSWORD_PARAM = /\b(password|passwd|pwd|sslpassword)=([^&\s;]*)/gi;

/**
 * Returns the URL with any password replaced by `***`. Works on strings that are not valid
 * URLs too, so it is safe to call on arbitrary user input before logging it.
 */
export function redactUrl(url: string): string {
  return url.replace(URL_CREDENTIALS, `$1${REDACTED}@`).replace(PASSWORD_PARAM, `$1=${REDACTED}`);
}

/**
 * Removes credentials from free text: URL passwords, `password=` pairs and every known
 * secret value. Secrets shorter than three characters are only removed through the URL and
 * key/value patterns, because replacing them everywhere would corrupt unrelated text.
 */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = redactUrl(text);
  for (const secret of secrets) {
    if (secret.length >= 3) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Formats an unknown thrown value as a message with credentials removed. */
export function safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, secrets);
}

/** Driver error code (`23505`, `SQLITE_BUSY`, ...) when one is present. */
export function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
