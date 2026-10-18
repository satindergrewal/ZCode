# ZCode Plugin Store

Domain glossary for the plugin settings page and its marketplace browse/install experience. This file is the single source of truth for store terminology across pages, services, and docs.

## Language

### Marketplace and sources

**Official Marketplace**:
The only distribution channel operated by ZCode officially; marketplace id `zcode-plugins-official`; content = builtin plugins + CDN plugins. It is a _distribution channel_, not an attribution — community-authored plugins can be listed in it.
_Avoid_: using "official" for any trusted market

**Builtin Plugin**:
Ships inside the app bundle and is seeded into the Official Marketplace at startup. A subset of official plugins.
_Avoid_: preinstalled plugin, bundled plugin (colloquial OK; docs say "builtin")

**CDN Plugin**:
In the Official Marketplace, distributed via the official CDN as a sha256-verified zip, downloaded and installed on demand.
_Avoid_: network plugin, online plugin

**Personal Source**:
Any plugin source the user adds themselves: git/GitHub/URL/local-directory marketplaces, inline plugins.
_Avoid_: —

**Catalog Auto-Refresh**:
Throttled background refresh of the Official Marketplace catalog when entering the store page, invisible to the user; covers the official marketplace only.
_Avoid_: confusing with Manual Refresh; calling it "check for updates" (the update badge is a side effect of the refresh)

**Manual Refresh**:
Full-catalog refresh triggered by the refresh button in the store page header; not throttled by auto-refresh.
_Avoid_: refresh, check for updates (colloquial OK; docs say "manual refresh")

### Store page structure

**Public Segment**:
One of the store list segments; shows exactly the Official Marketplace catalog (Featured + category blocks).
_Avoid_: official tab, store tab

**Personal Segment**:
The other list segment; shows the catalogs of all personal sources, grouped by marketplace.
_Avoid_: third-party tab, my tabs

**Featured**:
Curation block at the top of the Public segment; its list is remotely controlled by the `featured` field of the official CDN catalog. Exists only in the Public segment.
_Avoid_: confusing with Recommended

**Installed Strip**:
Row of installed-plugin icons at the top of the list page; clicking an icon opens the detail page.
_Avoid_: "installed list" (that is Manage Installed's job)

**Manage Installed View**:
Management screen behind the gear at the right of the Installed Strip; hosts per-plugin enable/disable toggles, update, uninstall, and enabled-state filters.
_Avoid_: Installed tab (legacy IA term, deprecated)

### Metadata

**Store Listing**:
Presentational metadata carried by catalog entries: display name, icon, category, author, website/privacy-policy/terms links, hero image, example prompts. Describes presentation in the store; does not affect plugin function.
_Avoid_: plugin metadata (ambiguous — may mean the manifest)

**Plugin Manifest**:
Functional definition in the plugin package's `plugin.json` (commands/agents/skills/hooks/mcpServers/userConfig…). Describes what the plugin is and does.
_Avoid_: marketplace.json (that is the catalog, not the manifest)

**Example Prompt**:
Clickable prompt offered by the Store Listing; clicking starts a new session prefilled (not auto-sent). The only "new session" entry on the detail page.
_Avoid_: quick action, prompt template, try now

### Lifecycle states

**Plugin Lifecycle**:
The full product path from discovering a plugin through viewing, installing, configuring, enabling/disabling, using, checking updates, upgrading, and persisted restore, to uninstall or builtin restore. Every stage must verify both the visible UI state and the corresponding persisted or runtime result.
_Avoid_: calling "install succeeded" the complete lifecycle

**Restorable Builtin**:
A Builtin Plugin the user uninstalled into a persisted suppressed state. The app must not re-seed it automatically on restart; it remains visible in the Public segment and is cleanly restored via the "install" entry.
_Avoid_: not-installed CDN plugin, temporarily disabled builtin

**Orphaned Installed Plugin**:
A plugin whose Personal Source was removed while its install directory and user data remain. It stays usable, configurable, toggleable, and uninstallable; it cannot update until the source is re-added, and re-adding the same source restores the catalog linkage.
_Avoid_: broken install, missing manifest, uninstalled plugin
