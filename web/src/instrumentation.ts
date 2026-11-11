export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getFactory } = await import("./server/factory-instance.ts");
    await getFactory();
  }
}
