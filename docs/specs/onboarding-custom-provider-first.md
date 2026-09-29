# Spec: Custom-Provider-First Onboarding

## Product Rules

- The startup login gate (`WelcomeScreen` opened for reasons `startup-provider-required`, `session-expired`, `logout-provider-required`) shows **only the API-key / custom-provider setup form**: no Z.ai or BigModel OAuth buttons are rendered at startup.
- Account logins (Z.ai / BigModel OAuth) are added later from **Settings → Model settings**; those entries open the unified login screen in `login-entry` mode, which keeps the full provider list and existing behavior.
- The startup screen can be dismissed unconnected via the existing Skip action; the recorded provider-family skip settings keep the startup gate from re-opening on later launches.
- `manual-login` and `provider-request` reasons keep today's behavior unchanged (provider buttons + API-key toggle).

## State Owners

| State | Single Owner | Notes |
| ----- | ------------ | ----- |
| Login screen mode | `mode` prop on `WelcomeScreen` (`"startup" \| "login-entry"`) | Only decision point for which variant renders |
| Reason → mode mapping | `Root.tsx` welcome render | `manual-login` / `provider-request` → `login-entry`; everything else → `startup` |
| Cancel visibility | `allowCancel` prop on `LoginApiKeyForm` | Startup variant has no providers view to return to, so Cancel is hidden |

## Interfaces

- `WelcomeScreen({ mode, onComplete })`: new required `mode` prop; `LoginCompleteReason` unchanged.
- `LoginApiKeyForm({ onCancel?, onSaved, onSkipped, allowCancel? })`: `onCancel` becomes optional, `allowCancel` defaults to `true`.
- No new i18n keys: the startup variant reuses the existing `login.apiKey.*` and `login.skip` strings.

## Acceptance Scenarios

1. Fresh install (no user, no provider): the startup gate renders the API-key form only; no OAuth provider buttons are visible.
2. Skip leaves the app unconnected and closes the gate; the provider-family skip settings prevent the gate from re-opening on the next launch.
3. Settings → Model settings → connect on an OAuth provider opens the unified login screen with the provider list (login-entry mode unchanged) and completes into the app on success.
4. The startup variant shows no Cancel button; Continue saves the API key and completes onboarding.
