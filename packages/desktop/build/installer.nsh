!include nsDialogs.nsh
!include FileFunc.nsh

!ifndef ZCODE_INSTALLER_DEFAULT_LOG_PATH
  !define ZCODE_INSTALLER_DEFAULT_LOG_PATH "$TEMP\ZCode-installer.log"
!endif
!ifndef ZCODE_INSTALLER_ELEVATED_LOG_PATH
  !define ZCODE_INSTALLER_ELEVATED_LOG_PATH "$WINDIR\Logs\ZCode-installer.log"
!endif
!ifndef ZCODE_INSTALLER_IS_ELEVATED_INNER
  ; Origin: only simulated in test fixtures for the inner instance; a permanent-false default would make the elevated process keep the caller's /LOG.
  ; Uses the same UAC predicate as electron-builder; isolation fixtures can still override it explicitly without changing the real elevation flow.
  !include UAC.nsh
  !define ZCODE_INSTALLER_IS_ELEVATED_INNER `${UAC_IsInnerInstance}`
!endif

!ifndef ZCODE_INSTALL_MANIFEST_NAME
  !define ZCODE_INSTALL_MANIFEST_NAME ".zcode-install-manifest"
!endif

!ifndef ZCODE_UNINSTALLER_LOG_PATH
  !define ZCODE_UNINSTALLER_LOG_PATH "$TEMP\ZCode-uninstaller.log"
!endif
!ifndef ZCODE_UNINSTALLER_FUNCTION_PREFIX
  !define ZCODE_UNINSTALLER_FUNCTION_PREFIX "un."
!endif

!ifdef BUILD_UNINSTALLER
  Var ZCodeUninstallerLogUnavailable

  ; The uninstaller only deletes old files during updates; record cleanup stages separately so the outer layer does not misreport permission/space errors as the app still running.
  !macro ZCodeReportUninstallerStage MESSAGE
    DetailPrint "ZCode: ${MESSAGE}"
    Push "${MESSAGE}"
    Call ${ZCODE_UNINSTALLER_FUNCTION_PREFIX}ZCodeWriteUninstallerLog
  !macroend

  Function ${ZCODE_UNINSTALLER_FUNCTION_PREFIX}ZCodeWriteUninstallerLog
    Exch $R9
    Push $R0
    Push $R1
    Push $R2

    StrCmp $ZCodeUninstallerLogUnavailable "1" zcodeUninstallerLogDone
    ClearErrors
    FileOpen $R1 "${ZCODE_UNINSTALLER_LOG_PATH}" a
    IfErrors zcodeUninstallerLogFailed zcodeUninstallerLogWrite
    zcodeUninstallerLogWrite:
      System::Call "kernel32::GetCurrentProcessId() i.R0"
      FileSeek $R1 0 END
      FileWrite $R1 "[pid=$R0] $R9$\r$\n"
      FileClose $R1
      Goto zcodeUninstallerLogDone
    zcodeUninstallerLogFailed:
      ; An unwritable log must not change the uninstall result; keep the original cleanup error for the outer layer.
      StrCpy $ZCodeUninstallerLogUnavailable "1"
      ClearErrors
    zcodeUninstallerLogDone:
      Pop $R2
      Pop $R1
      Pop $R0
      Pop $R9
  FunctionEnd

  !macro customRemoveFilesDiagnosticsStart
    !insertmacro ZCodeReportUninstallerStage "cleanup-started"
  !macroend

  !macro customRemoveFilesDiagnosticsComplete
    !insertmacro ZCodeReportUninstallerStage "cleanup-completed"
  !macroend
!endif

!macro customRemoveFiles
  ; electron-builder recursively deletes the whole $INSTDIR on update by default, wiping unrelated user files too.
  ; Delete only per the ownership manifest shipped with the previous version; when the manifest is missing, migrating old versions fails open and preserves files.
  ${if} ${isUpdated}
    !ifdef BUILD_UNINSTALLER
      !insertmacro customRemoveFilesDiagnosticsStart
    !endif
    ClearErrors
    FileOpen $R0 "$INSTDIR\${ZCODE_INSTALL_MANIFEST_NAME}" r
    IfErrors zcodeManifestMissing

    zcodeManifestRead:
      ClearErrors
      FileRead $R0 $R1
      IfErrors zcodeManifestClose
      ; NSIS FileRead keeps trailing CRLF; the packaged manifest always ends with a newline, so strip both line-ending characters.
      StrCpy $R1 $R1 -2
      StrCmp $R1 "" zcodeManifestRead

      ; Reject absolute paths and .. prefixes to avoid out-of-bounds deletes from corrupted or tampered manifests.
      StrCpy $R2 $R1 1
      StrCmp $R2 "\\" zcodeManifestRead
      StrCmp $R2 "/" zcodeManifestRead
      StrCpy $R2 $R1 2
      StrCmp $R2 ".." zcodeManifestRead
      StrCmp $R1 "${UNINSTALL_FILENAME}" zcodeManifestRead
      GetFullPathName $R2 "$INSTDIR\$R1"
      StrCmp $R2 "$INSTDIR\$R1" 0 zcodeManifestRead

      ; The current uninstaller and outer installer are separate processes; log each item to the uninstaller log to audit attempted deletes.
      !ifdef BUILD_UNINSTALLER
        !insertmacro ZCodeReportUninstallerStage "cleanup-file path=$R1"
      !endif
      ClearErrors
      Delete "$INSTDIR\$R1"
      IfErrors zcodeManifestDeleteFailed
      Goto zcodeManifestRead

    zcodeManifestDeleteFailed:
      FileClose $R0
      !ifdef BUILD_UNINSTALLER
        !insertmacro ZCodeReportUninstallerStage "cleanup-failed reason=permission-or-disk-space"
      !endif
      Abort "Unable to delete old version files: $INSTDIR\$R1"

    zcodeManifestClose:
      FileClose $R0
      Goto zcodeManifestDone

    zcodeManifestMissing:
      ; No manifest exists on the first upgrade from an old version; ownership cannot be guessed without risking user files.
      !ifdef BUILD_UNINSTALLER
        !insertmacro ZCodeReportUninstallerStage "cleanup-skipped reason=manifest-missing action=preserve"
      !endif
      ClearErrors

    zcodeManifestDone:
      !ifdef BUILD_UNINSTALLER
        !insertmacro customRemoveFilesDiagnosticsComplete
      !endif
  ${else}
    ; Plain uninstalls keep electron-builder's full-delete semantics; the ownership manifest only constrains overwrite updates.
    SetOutPath $TEMP
    RMDir /r $INSTDIR
  ${endIf}
!macroend

!ifndef BUILD_UNINSTALLER
  Var ZCodeInstallerLogPath
  Var ZCodeInstallerLogUnavailable
  Var ZCodeInstallerProcessRole
  Var ZCodeUninstallerDetailsUnavailable
  Var ZCodePreviousUninstallerSupportsManifest

  ; The details panel and file log share one stage event so silent installs keep critical context.
  !macro ZCodeReportInstallerStage MESSAGE
    SetDetailsPrint listonly
    DetailPrint "ZCode: ${MESSAGE}"
    Push "${MESSAGE}"
    Call ZCodeWriteInstallerLog
  !macroend

  Function ZCodeWriteInstallerLog
    Exch $R9
    Push $R0
    Push $R1
    Push $R2

    StrCmp $ZCodeInstallerLogPath "" zcodeInstallerLogDone
    StrCmp $ZCodeInstallerLogUnavailable "1" zcodeInstallerLogDone
    StrCpy $R2 0
    zcodeInstallerLogOpen:
      ClearErrors
      FileOpen $R1 $ZCodeInstallerLogPath a
      IfErrors zcodeInstallerLogRetry zcodeInstallerLogWrite
    zcodeInstallerLogRetry:
      IntOp $R2 $R2 + 1
      IntCmp $R2 3 zcodeInstallerLogFailed zcodeInstallerLogWait zcodeInstallerLogFailed
    zcodeInstallerLogWait:
      Sleep 50
      Goto zcodeInstallerLogOpen
    zcodeInstallerLogWrite:
      System::Call "kernel32::GetCurrentProcessId() i.R0"
      FileSeek $R1 0 END
      FileWrite $R1 "[pid=$R0] $R9$\r$\n"
      FileClose $R1
      Goto zcodeInstallerLogDone
    zcodeInstallerLogFailed:
      StrCpy $ZCodeInstallerLogUnavailable "1"
      ClearErrors
    zcodeInstallerLogDone:
      Pop $R2
      Pop $R1
      Pop $R0
      Pop $R9
  FunctionEnd

  Function ZCodeResetUninstallerLog
    StrCpy $ZCodeUninstallerDetailsUnavailable ""
    ClearErrors
    FileOpen $R0 "${ZCODE_UNINSTALLER_LOG_PATH}" w
    IfErrors zcodeUninstallerDetailsResetFailed zcodeUninstallerDetailsResetSucceeded
    zcodeUninstallerDetailsResetSucceeded:
      FileClose $R0
      Goto zcodeUninstallerDetailsResetDone
    zcodeUninstallerDetailsResetFailed:
      ; If the outer details view cannot read the old uninstaller log, keep installing; the file log and exit code remain authoritative.
      StrCpy $ZCodeUninstallerDetailsUnavailable "1"
      ClearErrors
    zcodeUninstallerDetailsResetDone:
  FunctionEnd

  Function ZCodeShowUninstallerCleanupDetails
    Push $R0
    Push $R1
    Push $R2

    StrCmp $ZCodeUninstallerDetailsUnavailable "1" zcodeShowUninstallerDetailsDone
    ClearErrors
    FileOpen $R0 "${ZCODE_UNINSTALLER_LOG_PATH}" r
    IfErrors zcodeShowUninstallerDetailsDone
    zcodeShowUninstallerDetailsRead:
      ClearErrors
      FileRead $R0 $R1
      IfErrors zcodeShowUninstallerDetailsClose
      StrCmp $R1 "" zcodeShowUninstallerDetailsRead
      SetDetailsPrint listonly
      DetailPrint "ZCode: cleanup-log $R1"
      Goto zcodeShowUninstallerDetailsRead
    zcodeShowUninstallerDetailsClose:
      FileClose $R0
    zcodeShowUninstallerDetailsDone:
      Pop $R2
      Pop $R1
      Pop $R0
  FunctionEnd

  !macro preInit
    Call ZCodeInitializeInstallerLog
  !macroend

  !macro customInit
    IfSilent zcodeInstallerInitSilent zcodeInstallerInitInteractive
    zcodeInstallerInitSilent:
      !insertmacro ZCodeReportInstallerStage "installer-initialized mode=silent"
      Goto zcodeInstallerInitDone
    zcodeInstallerInitInteractive:
      !insertmacro ZCodeReportInstallerStage "installer-initialized mode=interactive"
    zcodeInstallerInitDone:
  !macroend

  ; These macros are invoked in install order by the electron-builder installSection.nsh patch at packaging time.
  ; Only stage markers go to details and the log; file extraction details are printed by NSIS File commands in listonly mode.
  !macro customInstallSectionStarted
    !insertmacro ZCodeReportInstallerStage "install-started"
  !macroend

  !macro customInstallCleanupStarted
    Call ZCodeResetUninstallerLog
    !insertmacro ZCodeReportInstallerStage "cleanup-started"
  !macroend

  !macro customInstallCleanupCompleted
    !insertmacro ZCodeReportInstallerStage "cleanup-completed"
    Call ZCodeShowUninstallerCleanupDetails
  !macroend

  !macro customInstallExtractStarted
    !insertmacro ZCodeReportInstallerStage "extract-started"
  !macroend

  !macro customInstallExtractCompleted
    !insertmacro ZCodeReportInstallerStage "extract-completed"
  !macroend

  !macro customInstallShortcutsStarted
    !insertmacro ZCodeReportInstallerStage "shortcuts-started"
  !macroend

  !macro customInstallShortcutsCompleted
    !insertmacro ZCodeReportInstallerStage "shortcuts-completed"
  !macroend

  Function ZCodeDetectPreviousUninstallerCapabilities
    StrCpy $ZCodePreviousUninstallerSupportsManifest "0"
    ; The manifest marks uninstaller capability: its presence means the old uninstaller deletes selectively per the manifest.
    IfFileExists "$INSTDIR\${ZCODE_INSTALL_MANIFEST_NAME}" 0 zcodePreviousUninstallerCapabilityCheckNested
      StrCpy $ZCodePreviousUninstallerSupportsManifest "1"
      Return

    zcodePreviousUninstallerCapabilityCheckNested:
      ; The assisted installer directory page only adds the APP_FILENAME subdirectory later in instfilesPre; tolerate both layouts up front.
      IfFileExists "$INSTDIR\${APP_FILENAME}\${ZCODE_INSTALL_MANIFEST_NAME}" 0 zcodePreviousUninstallerCapabilityDone
        StrCpy $ZCodePreviousUninstallerSupportsManifest "1"

    zcodePreviousUninstallerCapabilityDone:
  FunctionEnd

  !macro customUnInstallCheck
    ; handleUninstallResult puts the old uninstaller's exit code in $R0; on failure show cleanup diagnostics
    ; instead of reusing appCannotBeClosed (that copy only fits a busy-process case).
    ${if} $R0 != 0
      ; Silent auto-updates run unattended; a modal without /SD would wait forever for a click,
      ; keeping the explicit exit code from reaching electron-updater. Auto-pick IDOK when silent; still prompt interactively.
      SetDetailsPrint listonly
      DetailPrint "ZCode: cleanup-failed exit-code=$R0"
      Call ZCodeShowUninstallerCleanupDetails
      MessageBox MB_OK|MB_ICONSTOP "Failed to clean up the previous version (error code $R0). Files may be in use, permissions insufficient, or disk space low. Detailed log: ${ZCODE_UNINSTALLER_LOG_PATH}" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
  !macroend

  !macro customUnInstallCheckCurrentUser
    ; When a per-machine install switches to HKCU for the old version, electron-builder takes another hook;
    # reuse the same diagnostics so one cleanup failure does not fall back to default copy over a different registry root.
    !insertmacro customUnInstallCheck
  !macroend
!endif

!define ZCODE_INSTALL_DIR_BACK_BUTTON_WIDTH 180

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; The async-generated header may include this file before the UAC plugin directory is registered.
    ; Expand the function in customHeader so the plugin is registered; preInit still calls the same function and real UAC predicate.
    Function ZCodeInitializeInstallerLog
      Push $R0
      Push $R1
      Push $R2
      StrCpy $ZCodeInstallerLogUnavailable ""
      ${If} ${ZCODE_INSTALLER_IS_ELEVATED_INNER}
        StrCpy $ZCodeInstallerProcessRole "elevated-inner"
        StrCpy $ZCodeInstallerLogPath "${ZCODE_INSTALLER_ELEVATED_LOG_PATH}"
      ${Else}
        StrCpy $ZCodeInstallerProcessRole "outer"
        StrCpy $R0 $CMDLINE
        ClearErrors
        ${GetOptions} $R0 "/LOG=" $R1
        IfErrors zcodeInstallerLogUseDefault
        StrCmp $R1 "" zcodeInstallerLogUseDefault
        StrCpy $ZCodeInstallerLogPath $R1
        Goto zcodeInstallerLogPathReady
        zcodeInstallerLogUseDefault:
          StrCpy $ZCodeInstallerLogPath "${ZCODE_INSTALLER_DEFAULT_LOG_PATH}"
        zcodeInstallerLogPathReady:
          ${GetParent} $ZCodeInstallerLogPath $R2
          StrCmp $R2 "" zcodeInstallerLogInitialized
          CreateDirectory "$R2"
      ${EndIf}
      zcodeInstallerLogInitialized:
        !insertmacro ZCodeReportInstallerStage "installer-process-started role=$ZCodeInstallerProcessRole"
      Pop $R2
      Pop $R1
      Pop $R0
    FunctionEnd

    ; electron-builder's common.nsh sets ShowInstDetails nevershow first;
    ; hide can still leave a blank list with no expander in that template combo, so stage details stay always visible.
    ShowInstDetails show
    !ifdef allowToChangeInstallationDirectory
      ; electron-builder already uses this flag in assistedInstaller.nsh to build the install directory page,
      ; but installUtil.nsh later also uses it to block manual overwrite-without---updated from keeping shortcuts, making the old
      ; uninstaller call UninstShortcut to unregister Start Menu pins. Drop the flag after page creation so auto-update and manual
      ; overwrite keeps the same .lnk via KeepShortcuts when targeting the same install dir.
      !undef allowToChangeInstallationDirectory
    !endif
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  ; electron-builder compiles the uninstaller first, but the shortcut target read only runs in the install-update flow.
  ; Keeping the function in the uninstaller triggers NSIS warning 6010 (unreferenced) and breaks Windows CI under /WX.
  Function ZCodeReadShortcutTarget
    Exch $R9
    Push $R1
    Push $R2

    StrCpy $R2 ""
    System::Call 'Kernel32::SetEnvironmentVariableW(w "ZCODE_SHORTCUT_PATH", w "$R9") i.R1'
    StrCmp $R1 "0" zcodeReadShortcutTargetDone 0

    nsExec::ExecToStack /TIMEOUT=5000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "[Console]::Out.Write(([Activator]::CreateInstance([type]::GetTypeFromProgID('WScript.Shell'))).CreateShortcut([Environment]::GetEnvironmentVariable('ZCODE_SHORTCUT_PATH')).TargetPath)"`
    Pop $R1
    Pop $R2
    StrCmp $R1 "0" zcodeReadShortcutTargetDone 0
    StrCpy $R2 ""

    zcodeReadShortcutTargetDone:
      System::Call 'Kernel32::SetEnvironmentVariableW(w "ZCODE_SHORTCUT_PATH", p 0) i.R1'
      StrCpy $R9 "$R2"
      Pop $R2
      Pop $R1
      Exch $R9
  FunctionEnd
!endif

!macro ZCodeRepairShortcutIfNeeded SHORTCUT_PATH LABEL_PREFIX
  ${if} ${FileExists} "${SHORTCUT_PATH}"
    Push "${SHORTCUT_PATH}"
    Call ZCodeReadShortcutTarget
    Pop $R0
    StrCmp $R0 "$appExe" ${LABEL_PREFIX}Done 0

    ; Older versions can leave .lnk files pointing at a moved exe, but unconditionally overwriting correct shortcuts makes
    ; some Windows 11 builds lose the "All apps" entry or the user's pin, so only repair items whose target differs.
    ClearErrors
    CreateShortCut "${SHORTCUT_PATH}" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    IfErrors ${LABEL_PREFIX}Failed ${LABEL_PREFIX}Succeeded
    ${LABEL_PREFIX}Failed:
      DetailPrint "Unable to repair shortcut: ${SHORTCUT_PATH}"
      ClearErrors
      Goto ${LABEL_PREFIX}Done
    ${LABEL_PREFIX}Succeeded:
      WinShell::SetLnkAUMI "${SHORTCUT_PATH}" "${APP_ID}"
      ; The rewritten .lnk must notify the shell after the final write so the Start menu stops using the stale index.
      System::Call 'Shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "${SHORTCUT_PATH}", p 0)'
    ${LABEL_PREFIX}Done:
  ${endIf}
!macroend

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    !insertmacro ZCodeReportInstallerStage "install-finalization-started"
  !endif
  ${if} ${isUpdated}
  ${orIf} $keepShortcuts == "true"
    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      !insertmacro ZCodeRepairShortcutIfNeeded "$newStartMenuLink" zcodeStartMenuShortcutRepair
    !endif

    !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
      !insertmacro ZCodeRepairShortcutIfNeeded "$newDesktopLink" zcodeDesktopShortcutRepair
    !endif
  ${endIf}

  ; Manual overwrite has no --updated; inherited shortcuts still need a target check. A first install has no old items,
  ; so do not spawn PowerShell. Shortcuts deleted by the user are not recreated.
  ; The assisted installer finish page always runs the exe written by this install.
  StrCpy $launchLink "$appExe"
  !ifndef BUILD_UNINSTALLER
    !insertmacro ZCodeReportInstallerStage "install-completed"
  !endif
!macroend

!macro customPageAfterChangeDir
  Function ZCodeResizeInstallDirBackButton
    GetDlgItem $1 $HWNDPARENT 3
    StrCmp $1 0 zcodeResizeInstallDirBackButtonDone 0

    System::Call "*(i 0, i 0, i 0, i 0) p.r2"
    StrCmp $2 0 zcodeResizeInstallDirBackButtonDone 0
    System::Call "user32::GetWindowRect(p r1, p r2)"
    System::Call "user32::MapWindowPoints(p 0, p $HWNDPARENT, p r2, i 2)"
    System::Call "*$2(i.r3,i.r4,i.r5,i.r6)"
    System::Free $2

    IntOp $7 $5 - $3
    IntOp $8 $6 - $4
    IntCmp $7 ${ZCODE_INSTALL_DIR_BACK_BUTTON_WIDTH} zcodeResizeInstallDirBackButtonDone zcodeResizeInstallDirBackButtonResize zcodeResizeInstallDirBackButtonDone

    zcodeResizeInstallDirBackButtonResize:
      ; The block page renames Back to an action label; the default NSIS button width could clip the text.
      ; Widen leftwards keeping the right edge fixed to avoid overlapping the Install/Cancel buttons.
      IntOp $3 $5 - ${ZCODE_INSTALL_DIR_BACK_BUTTON_WIDTH}
      System::Call "user32::MoveWindow(p r1, i r3, i r4, i ${ZCODE_INSTALL_DIR_BACK_BUTTON_WIDTH}, i r8, i 1)"

    zcodeResizeInstallDirBackButtonDone:
  FunctionEnd

  Function ZCodeFindNestedDataDir
    Exch $R9
    Push $0
    Push $1

    StrCpy $R2 ""

    IfFileExists "$R9\.zcode\*.*" 0 +2
      StrCpy $R2 "$R9\.zcode"
    StrCmp $R2 "" 0 zcodeFindNestedDataDirDone
    IfFileExists "$R9\.zcode" 0 zcodeFindNestedDataDirListChildren
      StrCpy $R2 "$R9\.zcode"
    StrCmp $R2 "" 0 zcodeFindNestedDataDirDone

    zcodeFindNestedDataDirListChildren:
      FindFirst $0 $1 "$R9\*"
      IfErrors zcodeFindNestedDataDirDone

    zcodeFindNestedDataDirNext:
      StrCmp $1 "" zcodeFindNestedDataDirClose
      StrCmp $1 "." zcodeFindNestedDataDirContinue
      StrCmp $1 ".." zcodeFindNestedDataDirContinue
      IfFileExists "$R9\$1\*.*" 0 zcodeFindNestedDataDirContinue
        Push "$R9\$1"
        Call ZCodeFindNestedDataDir
        StrCmp $R2 "" zcodeFindNestedDataDirContinue zcodeFindNestedDataDirClose

    zcodeFindNestedDataDirContinue:
      FindNext $0 $1
      IfErrors zcodeFindNestedDataDirClose
      Goto zcodeFindNestedDataDirNext

    zcodeFindNestedDataDirClose:
      FindClose $0

    zcodeFindNestedDataDirDone:
      Pop $1
      Pop $0
      Pop $R9
  FunctionEnd

  Function ZCodeBlockInstallDirContainsData
    Call ZCodeDetectPreviousUninstallerCapabilities
    StrCmp $ZCodePreviousUninstallerSupportsManifest "1" zcodeInstallDirDataBlockSkip

    ;  Users may place the data directory inside the install dir; a Windows update overwriting the install dir would wipe .zcode.
    ; The assisted installer completes a chosen dir without the app name to "$INSTDIR\${APP_FILENAME}", so compute the final dir by the same rule.
    ${StrContains} $R1 "${APP_FILENAME}" "$INSTDIR"
    StrCmp $R1 "" 0 zcodeInstallDirDataBlockUseSelectedDir
    StrCpy $R0 "$INSTDIR\${APP_FILENAME}"
    Goto zcodeInstallDirDataBlockCheckDir

    zcodeInstallDirDataBlockUseSelectedDir:
      StrCpy $R0 "$INSTDIR"

    zcodeInstallDirDataBlockCheckDir:
      ; The old block only checked .zcode directly under the final install dir, missing data such as data\.zcode in subdirectories.
      ; Overwrite installs manage the whole install dir tree, so any nested .zcode hit must block.
      Push "$R0"
      Call ZCodeFindNestedDataDir
      StrCmp $R2 "" zcodeInstallDirDataBlockSkip zcodeInstallDirDataBlockFound

    zcodeInstallDirDataBlockFound:
      IfSilent zcodeInstallDirDataBlockSilent

      !insertmacro MUI_HEADER_TEXT "Installation directory needs changes" "The install directory or a subdirectory contains a ZCode data directory"
      nsDialogs::Create 1018
      Pop $0
      StrCmp $0 error zcodeInstallDirDataBlockDialogFailed 0

      ${NSD_CreateLabel} 0u 0u 300u 44u "A .zcode data directory was found in this install directory or a subdirectory:$\r$\n$R2"
      Pop $1
      ${NSD_CreateLabel} 0u 54u 300u 70u "To keep previous sessions and settings from being wiped by the installer, go back and choose another install directory.$\r$\n$\r$\nInstallation cannot continue in this directory."
      Pop $1

      GetDlgItem $1 $HWNDPARENT 1
      EnableWindow $1 0
      GetDlgItem $1 $HWNDPARENT 3
      EnableWindow $1 1
      SendMessage $1 ${WM_SETTEXT} 0 "STR:Choose folder"
      Call ZCodeResizeInstallDirBackButton

      nsDialogs::Show
      Return

    zcodeInstallDirDataBlockDialogFailed:
      MessageBox MB_OK|MB_ICONSTOP "A .zcode data directory was found in the install directory or a subdirectory; installation stopped. Run the installer again and choose a different install directory."
      SetErrorLevel 1
      Quit

    zcodeInstallDirDataBlockSilent:
      SetErrorLevel 1
      Quit

    zcodeInstallDirDataBlockSkip:
      Abort
  FunctionEnd

  Function ZCodeBlockInstallDirContainsDataLeave
    ; The block page disables its Next button, but automation or system shortcuts can still trigger the next page.
    ; The leave callback only handles forward navigation; abort here to keep the user on this page to fix the install dir.
    Abort
  FunctionEnd

  Page custom ZCodeBlockInstallDirContainsData ZCodeBlockInstallDirContainsDataLeave
!macroend
