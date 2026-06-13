const DEFAULT_COMMAND_PREFIXES = ["agent", "opencode"];

export function parseCommand(text, commandPrefixes = DEFAULT_COMMAND_PREFIXES) {
  const prefixes = commandPrefixes
    .map((value) => String(value || "").replace(/^\/+/, ""))
    .filter(Boolean);
  if (prefixes.length === 0) return null;

  const pattern = new RegExp(`(?:^|\\n)\\s*\\/(${prefixes.map(escapeRegex).join("|")})\\s+(plan|approve|improve)\\b([^\\n]*)`, "i");
  const match = pattern.exec(text || "");
  if (!match) return null;
  return {
    tool: match[1].toLowerCase(),
    action: match[2].toLowerCase(),
    remainder: (match[3] || "").trim(),
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isTrustedAssociation(association, allowedAssociations) {
  const normalized = String(association || "").toUpperCase();
  return allowedAssociations.includes(normalized);
}

export function eventCommandSource(event) {
  if (event.comment?.body) return event.comment.body;
  if (event.issue?.body) return event.issue.body;
  return "";
}

export function eventActor(event) {
  return event.comment?.user?.login || event.sender?.login || event.issue?.user?.login || "unknown";
}

export function eventAssociation(event) {
  return event.comment?.author_association || event.issue?.author_association || "";
}

export function isPullRequestEvent(event) {
  return Boolean(event.issue?.pull_request);
}
