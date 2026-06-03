import { env } from "../config/env";

// Sends an email via the Resend HTTP API. If no API key is configured, it logs
// and skips (so the app keeps working without email set up).
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: boolean; skipped?: boolean }> {
  if (!env.resendApiKey) {
    console.warn(`[email] RESEND_API_KEY not set — skipped: ${opts.subject}`);
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.emailFrom,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      }),
    });
    if (!res.ok) {
      console.error("[email] send failed", res.status, await res.text().catch(() => ""));
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error("[email] send error", e);
    return { ok: false };
  }
}
