export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { describeProxy, ensureProxyDispatcher } = await import("./core/adapters/http/proxy.ts");
    ensureProxyDispatcher();
    console.log(`[factory] outbound HTTP ${describeProxy()}`);
    const { getFactory } = await import("./server/factory-instance.ts");
    await getFactory();
  }
}
