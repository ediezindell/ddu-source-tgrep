export function parseGitignore(text: string): (name: string) => boolean {
  const patterns: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("!")) {
      continue;
    }
    patterns.push(line.replace(/^\/+/, "").replace(/\/+$/, ""));
  }
  return (name: string) => patterns.some((pattern) => pattern === name);
}
