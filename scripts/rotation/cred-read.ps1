# Read a GitHub token from Windows Credential Manager and print it to stdout.
#
# Usage:
#   TOKEN=$(powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rotation/cred-read.ps1)
#
# Mirrors cred-swap.ps1's blob decoding exactly: UTF-16LE first (the swap
# helper's write format), UTF-8 fallback. Prints the token only — capture it,
# never echo it in transcripts.
param(
  [string]$Target = 'gh:github.com:Creative-hub554'
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredManRead {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr credPtr);
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
}
"@

$v = [CredManRead]::Read($Target)
[Console]::Out.Write($v)
