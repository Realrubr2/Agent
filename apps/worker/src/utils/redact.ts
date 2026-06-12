const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /sk-[A-Za-z0-9_-]+/g,
  /(OPENAI_API_KEY|OPENROUTER_API_KEY|GITHUB_TOKEN|GH_TOKEN|LANGFUSE_SECRET_KEY|OPENCODE_SERVER_PASSWORD)=\S+/gi,
  /(https?:\/\/)([^:\s/@]+):([^@\s/]+)@/g,
];

export function redactSecrets(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, protocol) => {
      if (protocol && match.includes("@")) return `${protocol}<redacted>@`;
      const key = match.split("=").at(0);
      return match.includes("=") ? `${key}=<redacted>` : "<redacted>";
    });
  }
  return text;
}
