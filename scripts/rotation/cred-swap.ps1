# Windows Credential Manager token swap with verification and rollback.
#
# Usage (normally invoked by rotate-hard.cjs, NEW_TOKEN via env):
#   $env:NEW_TOKEN = '<gho_...>'; powershell -NoProfile -ExecutionPolicy Bypass `
#     -File scripts/rotation/cred-swap.ps1 -Target 'gh:github.com:Creative-hub554'
#
# Preserves Persist + UserName from the existing credential, writes the new
# token, reads the blob back and compares exactly, and rolls back to the old
# value on any mismatch. Never prints or persists the token beyond CredMan.
#
# Output: SWAP_OK | NO_CHANGE_NEEDED | OLD_CRED_MISSING | CREDWRITE_FAILED |
#         SWAP_FAILED_ROLLED_BACK | SWAP_FAILED_ROLLBACK_UNVERIFIED
param(
  [string]$Target = 'gh:github.com:Creative-hub554'
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredManSwap {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr credPtr);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    byte[] blob = new byte[c.CredentialBlobSize];
    Marshal.Copy(c.CredentialBlob, blob, 0, blob.Length);
    Marshal.FreeCoTaskMem(p);
    string uni = System.Text.Encoding.Unicode.GetString(blob).TrimEnd('\0');
    if (uni != null && uni.StartsWith("gh")) return uni;
    return System.Text.Encoding.UTF8.GetString(blob).TrimEnd('\0');
  }
  public static CREDENTIAL ReadStruct(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) throw new InvalidOperationException("cred not found");
    return (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
  }
}
"@

$target = $Target
$new = $env:NEW_TOKEN
if (-not $new) { Write-Output 'OLD_CRED_MISSING'; exit 1 }
$old = [CredManSwap]::Read($target)
if (-not $old) { Write-Output 'OLD_CRED_MISSING'; exit 1 }
if ($old -ceq $new) { Write-Output 'NO_CHANGE_NEEDED'; exit 0 }

$st = [CredManSwap]::ReadStruct($target)
function Write-Cred([string]$val) {
  $size = [System.Text.Encoding]::Unicode.GetByteCount($val)
  $ptr = [System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($val)
  $c = New-Object CredManSwap+CREDENTIAL
  $c.Flags = 0; $c.Type = 1; $c.TargetName = $target
  $c.Comment = 'rotated via device flow; scopes repo workflow gist read:org'
  $c.CredentialBlobSize = $size; $c.CredentialBlob = $ptr; $c.Persist = $st.Persist
  $c.AttributeCount = 0; $c.Attributes = [IntPtr]::Zero; $c.TargetAlias = $null; $c.UserName = $st.UserName
  $ok = [CredManSwap]::CredWriteW([ref]$c, 0)
  [System.Runtime.InteropServices.Marshal]::FreeCoTaskMem($ptr)
  return $ok
}
if (-not (Write-Cred $new)) { Write-Output 'CREDWRITE_FAILED'; exit 1 }
$check = [CredManSwap]::Read($target)
if ($check -ceq $new) { Write-Output 'SWAP_OK'; exit 0 }
$okBack = Write-Cred $old
if ($okBack -and ([CredManSwap]::Read($target) -ceq $old)) { Write-Output 'SWAP_FAILED_ROLLED_BACK' } else { Write-Output 'SWAP_FAILED_ROLLBACK_UNVERIFIED' }
exit 1
