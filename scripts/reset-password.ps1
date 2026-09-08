$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$email = Read-Host "Enabled local account email"
$securePassword = Read-Host "New password (12-256 bytes)" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "node"
    $startInfo.WorkingDirectory = $repositoryRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.Arguments = "--import tsx apps/api/src/auth/recovery.ts"
    $startInfo.EnvironmentVariables["SHI_RECOVERY_EMAIL"] = $email
    $process = [Diagnostics.Process]::Start($startInfo)
    $passwordBytes = [Text.Encoding]::UTF8.GetBytes($plainPassword)
    $process.StandardInput.BaseStream.Write($passwordBytes, 0, $passwordBytes.Length)
    $process.StandardInput.Close()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "Password reset command failed" }
}
finally {
    $plainPassword = $null
    if ($passwordBytes) { [Array]::Clear($passwordBytes, 0, $passwordBytes.Length) }
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
