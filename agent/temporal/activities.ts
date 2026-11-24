// An Activity is a normal function that does one action, such as calling an
// API or writing to a database. Temporal retries it if it fails.
export async function greet(name: string): Promise<string> {
  return `Hello, ${name}!`;
}
