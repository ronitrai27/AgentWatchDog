// Runs once when the Next.js server starts, before the first request: compiles Rox's graph,
// checks and warms what it needs, and prints the result.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startRox } = await import("./lib/startup");
    await startRox();
  } catch (error) {
    console.error(
      `Rox could not start: ${error instanceof Error ? error.message : error}`,
    );
  }
}
