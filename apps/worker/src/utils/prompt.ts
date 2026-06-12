import crypto from "node:crypto";

export function promptHash(prompt) {
  return crypto.createHash("sha256").update(String(prompt)).digest("hex");
}

export function summarizePrompt(prompt, maxLength = 160) {
  const sanitized = sanitizePromptForLog(prompt);
  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength - 3)}...` : sanitized;
}

export function sanitizePromptForLog(prompt) {
  return String(prompt)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
