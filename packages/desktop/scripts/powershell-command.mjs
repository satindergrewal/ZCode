const POWERSHELL_COMMON_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive"];

const WINDOWS_POWERSHELL_SECURITY_BOOTSTRAP = [
  "$ErrorActionPreference='Stop';",
  "try{",
  "$zcodeSecurityModule=[IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1');",
  "Import-Module -Name $zcodeSecurityModule -Force -ErrorAction Stop;",
  "}catch{",
  "[Console]::Error.WriteLine(('Windows PowerShell Security module load failed: {0}' -f $_.Exception.Message));",
  "exit 26;",
  "};",
].join("");

function encodeUtf8Value(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

export function createEncodedPowerShellArgs(script, values = []) {
  // Windows PowerShell 5.1 concatenates argv after plain `-Command` back into the command text
  // instead of injecting them into $args. Encode dynamic values separately into -EncodedCommand, which also avoids
  // PowerShell re-parsing Program Files spaces, quotes, or semicolons as script content.
  const valueBindings = values
    .map(
      (value, index) =>
        `$zcodeArg${index}=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodeUtf8Value(value)}'));`,
    )
    .join("");
  const encodedCommand = Buffer.from(`${valueBindings}${script}`, "utf16le").toString("base64");
  return [...POWERSHELL_COMMON_ARGS, "-EncodedCommand", encodedCommand];
}

export function createWindowsPowerShellSecurityArgs(script, values = []) {
  // Node spawned by pwsh inherits PowerShell 7's PSModulePath; a later Windows PowerShell 5.1 launch
  // can then wrongly discover incompatible Security modules. Load system modules from the current
  // powershell.exe PSHOME instead of trusting external env as the module trust root.
  return createEncodedPowerShellArgs(`${WINDOWS_POWERSHELL_SECURITY_BOOTSTRAP}${script}`, values);
}
