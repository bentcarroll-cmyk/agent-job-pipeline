// Slack truncates plain text above 40,000 characters. Leave room below that
// boundary and split at newlines so every posting URL stays usable.
// https://docs.slack.dev/reference/methods/chat.postMessage/
const SLACK_TEXT_LIMIT = 39_000;

export function splitSlackText(text: string): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let current: string | undefined;
  for (const line of text.split("\n")) {
    if (line.length > SLACK_TEXT_LIMIT) {
      throw new RangeError("Slack text line exceeds the message limit");
    }
    if (current === undefined) current = line;
    else if (current.length + line.length + 1 <= SLACK_TEXT_LIMIT) current += `\n${line}`;
    else {
      chunks.push(current);
      current = line;
    }
  }
  if (current !== undefined) chunks.push(current);
  return chunks;
}
