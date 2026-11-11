import "server-only";
import { NextResponse } from "next/server";
import { ANONYMOUS, isStoreError, type Principal } from "@/core/ports/index.ts";
import { getFactory } from "./factory-instance.ts";
import type { Factory } from "@/core/factory.ts";

/** ADR-0009 seam: the OIDC Authenticator replaces this in v0.4. */
export async function principalFrom(_req: Request): Promise<Principal> {
  return ANONYMOUS;
}

/** Wraps a route: resolves the principal + factory, maps errors to HTTP. */
export function handler<C>(fn: (ctx: { req: Request; p: Principal; f: Factory; params: C }) => Promise<unknown>) {
  return async (req: Request, ctx: { params: Promise<C> }) => {
    try {
      const [p, f, params] = await Promise.all([principalFrom(req), getFactory(), ctx.params]);
      const result = await fn({ req, p, f, params });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = isStoreError(e)
        ? { NotFound: 404, AlreadyExists: 409, Conflict: 409, ReadOnly: 403, Invalid: 422 }[e.code]
        : /not found/i.test(message)
          ? 404
          : 400;
      return NextResponse.json({ error: message, details: isStoreError(e) ? e.details : undefined }, { status });
    }
  };
}
