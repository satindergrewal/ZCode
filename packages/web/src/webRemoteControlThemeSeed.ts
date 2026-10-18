import { isWebRemoteControlThemeSeed, type WebRemoteControlThemeSeed } from "@zcode/shared";

export const WEB_REMOTE_CONTROL_DEFAULT_THEME: WebRemoteControlThemeSeed = "zai-dark";

function normalizeWebRemoteControlThemeSeed(
  theme: WebRemoteControlThemeSeed,
): WebRemoteControlThemeSeed {
  if (theme === "dark") return "zai-dark";
  if (theme === "light") return "zai-light";
  return theme;
}

export function resolveWebRemoteControlInitialTheme({
  storedTheme,
  qrTheme,
  defaultTheme = WEB_REMOTE_CONTROL_DEFAULT_THEME,
}: {
  storedTheme?: string | null;
  qrTheme?: string | null;
  defaultTheme?: WebRemoteControlThemeSeed;
}): WebRemoteControlThemeSeed {
  if (isWebRemoteControlThemeSeed(storedTheme)) {
    return normalizeWebRemoteControlThemeSeed(storedTheme);
  }

  if (isWebRemoteControlThemeSeed(qrTheme)) {
    return normalizeWebRemoteControlThemeSeed(qrTheme);
  }

  return normalizeWebRemoteControlThemeSeed(defaultTheme);
}

export function seedWebRemoteControlThemePreference(qrTheme?: string | null): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  const storedTheme = localStorage.getItem("zcode-theme");
  const resolvedTheme = resolveWebRemoteControlInitialTheme({ storedTheme, qrTheme });
  if (!storedTheme && isWebRemoteControlThemeSeed(qrTheme)) {
    // Bugfix: first mobile remote-control open used to hardcode the web default theme, losing the desktop theme chosen at scan time.
    // Write once only when the phone has no local theme preference yet; later phone changes never feed back to desktop.
    localStorage.setItem("zcode-theme", resolvedTheme);
  }
}
