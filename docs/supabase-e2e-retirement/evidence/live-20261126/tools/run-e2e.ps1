# Reads the Supabase CLI's stored credential ("Supabase CLI:supabase") from the Windows credential
# store and passes it ONLY to the child node process's environment. It is never printed or written.
param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$NodeArgs)
$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class CredReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p; if (!CredRead(target, 1, 0, out p)) return null;
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      var bytes = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, bytes, 0, c.CredentialBlobSize);
      return System.Text.Encoding.UTF8.GetString(bytes); } finally { CredFree(p); }
  }
}
'@
if (-not ('CredReader' -as [type])) { Add-Type -TypeDefinition $sig }
$tok = [CredReader]::Read('Supabase CLI:supabase')
if (-not $tok) { Write-Output 'credential "Supabase CLI:supabase" not readable'; exit 3 }
$env:E2E_MGMT_TOKEN = $tok
try {
  & node "$PSScriptRoot\e2e-api.js" @NodeArgs
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:E2E_MGMT_TOKEN -ErrorAction SilentlyContinue
  $tok = $null
}
exit $code
