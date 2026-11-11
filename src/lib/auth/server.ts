import { createNeonAuth } from "@neon/auth/next/server";

const buildPhase = process.env.NEXT_PHASE === "phase-production-build";
const productionRuntime = process.env.NODE_ENV === "production" && !buildPhase;
const baseUrl = process.env.NEON_AUTH_BASE_URL ?? "http://localhost:3000";
const cookieSecret = process.env.NEON_AUTH_COOKIE_SECRET ?? "local-development-cookie-secret-change-me";

if (productionRuntime && (!process.env.NEON_AUTH_BASE_URL || !process.env.NEON_AUTH_COOKIE_SECRET)) {
  throw new Error("NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET are required in production");
}

export const auth = createNeonAuth({
  baseUrl,
  cookies: {
    secret: cookieSecret,
  },
});
