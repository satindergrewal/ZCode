// Prints the screen geometry of the System Settings main window for CUA permission panel snap positioning.
//
// Why a standalone binary: snapping needs exactly one datum — the System Settings window bounds. The right API is
// CGWindowListCopyWindowInfo, which requires **no TCC permission at all** (only capturing window *images* needs Screen
// Recording). That is the premise of the whole design: during permission onboarding the app has no accessibility/screen-recording grant yet.
// Electron has no binding for this API and every other route dead-ends: osascript + System Events needs accessibility
// permission (a deadlock), desktopCapturer gives window names but not bounds, and FFI bridges like koffi are native addons
// requiring electron-rebuild. Hence a sub-100KB bundle-free command-line tool.
//
// Resident design: prints one JSON line per interval. The parent spawns once and reads stdout — forking per frame
// (~10ms x 7 per second) is unacceptable.
//
// Usage: zcode-window-bounds [intervalMs]   default 150ms

import CoreGraphics
import Foundation

let intervalMs = UInt32(CommandLine.arguments.dropFirst().first.flatMap { UInt32($0) } ?? 150)
// The System Settings process name varies by macOS version/locale; 13+ is "System Settings", earlier is
// "System Preferences", and zh systems use localized names.
let settingsOwners = ["System Settings", "System Preferences", "系统设置", "系統設定"]

// Line buffering: the parent reads line by line; default full buffering would stall data in the stdio buffer until 4KB fills.
setvbuf(stdout, nil, _IOLBF, 0)

while true {
    var windows: [[String: Any]] = []

    if let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] {
        for window in list {
            guard let owner = window[kCGWindowOwnerName as String] as? String,
                settingsOwners.contains(where: { owner.contains($0) }),
                let boundsDict = window[kCGWindowBounds as String] as? [String: Any],
                let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
            else { continue }

            windows.append([
                "x": rect.origin.x,
                "y": rect.origin.y,
                "w": rect.size.width,
                "h": rect.size.height,
                // Consumers only accept layer 0 (regular windows). The Settings app also surfaces layer > 0 auxiliary
                // windows (tooltips, pop-up pickers); snapping to those would throw the panel into a screen corner.
                "layer": window[kCGWindowLayer as String] as? Int ?? -1,
            ])
        }
    }

    // Emit an empty array even with no matching window: the parent learns "settings closed" rather than "probe hung".
    if let data = try? JSONSerialization.data(withJSONObject: windows),
        let line = String(data: data, encoding: .utf8)
    {
        print(line)
    }

    usleep(intervalMs * 1000)
}
