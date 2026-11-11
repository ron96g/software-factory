import type { MantineColorScheme, MantineColorSchemeManager } from "@mantine/core";

export const COLOR_SCHEME_COOKIE = "sf-color-scheme";

export const isColorScheme = (v: unknown): v is MantineColorScheme => v === "light" || v === "dark" || v === "auto";

/**
 * Persists the color scheme in a cookie so the server renders the right scheme on <html>
 * (no flash, no inline script).
 */
export function cookieColorSchemeManager(): MantineColorSchemeManager {
  return {
    get(defaultValue) {
      if (typeof document === "undefined") return defaultValue;
      const m = new RegExp(`(?:^|; )${COLOR_SCHEME_COOKIE}=([^;]*)`).exec(document.cookie);
      return m && isColorScheme(m[1]) ? m[1] : defaultValue;
    },
    set(value) {
      document.cookie = `${COLOR_SCHEME_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
    },
    subscribe() {},
    unsubscribe() {},
    clear() {
      document.cookie = `${COLOR_SCHEME_COOKIE}=; path=/; max-age=0`;
    },
  };
}
