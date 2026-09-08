$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$email = Read-Host "Practice administrator email"
$displayName = Read-Host "Display name"
$securePassword = Read-Host "Password (12-256 bytes)" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "node"
    $startInfo.WorkingDirectory = $repositoryRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    # Fixed arguments work on Windows PowerShell 5.1 as well as PowerShell 7.
    # User-provided identity never becomes shell syntax; password stays on stdin.
    $startInfo.Arguments = "--import tsx apps/api/src/auth/bootstrap.ts --environment-identity"
    $startInfo.EnvironmentVariables["SHI_BOOTSTRAP_EMAIL"] = $email
    $startInfo.EnvironmentVariables["SHI_BOOTSTRAP_DISPLAY_NAME"] = $displayName
    $process = [Diagnostics.Process]::Start($startInfo)
    $passwordBytes = [Text.Encoding]::UTF8.GetBytes($plainPassword)
    $process.StandardInput.BaseStream.Write($passwordBytes, 0, $passwordBytes.Length)
    $process.StandardInput.Close()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "Bootstrap command failed" }
}
finally {
    $plainPassword = $null
    if ($passwordBytes) { [Array]::Clear($passwordBytes, 0, $passwordBytes.Length) }
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
