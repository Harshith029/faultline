param(
  [string]$AppId = "YOUR_AMPLIFY_APP_ID",
  [string]$Region = "ap-south-1",
  [string]$Branch = "production",
  [string]$ApiUrl = "https://YOUR_API_ID.execute-api.ap-south-1.amazonaws.com/prod"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dashboard = Join-Path $root "frontend\dashboard"
$distDir = Join-Path $dashboard "dist"

Write-Host "Building with VITE_API_URL=$ApiUrl"
$env:VITE_API_URL = $ApiUrl
# cmd /c merges stderr so vite warnings don't become terminating errors under EAP=Stop
cmd /c "npm --prefix `"$dashboard`" run build 2>&1"
if ($LASTEXITCODE -ne 0) { throw "build failed" }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Join-Path $env:TEMP "faultline-deploy.zip"
if (Test-Path $zip) { [System.IO.File]::Delete($zip) }
$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
Get-ChildItem -Path $distDir -Recurse -File | ForEach-Object {
  # Zip entries must use forward slashes or Amplify serves 404s
  $rel = $_.FullName.Substring($distDir.Length + 1) -replace '\\','/'
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $rel) | Out-Null
}
$archive.Dispose()
Write-Host "Zipped dist -> $zip"

$dep = aws amplify create-deployment --app-id $AppId --branch-name $Branch --region $Region | ConvertFrom-Json
if (-not $dep.zipUploadUrl) { throw "create-deployment failed (check aws login)" }

$resp = Invoke-WebRequest -Method Put -InFile $zip -Uri $dep.zipUploadUrl -ContentType "application/zip" -UseBasicParsing -TimeoutSec 120
if ($resp.StatusCode -ne 200) { throw "zip upload failed: HTTP $($resp.StatusCode)" }
Write-Host "Uploaded artifact (job $($dep.jobId))"

aws amplify start-deployment --app-id $AppId --branch-name $Branch --region $Region --job-id $dep.jobId | Out-Null

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 6
  $status = aws amplify get-job --app-id $AppId --branch-name $Branch --region $Region --job-id $dep.jobId --query "job.summary.status" --output text
  Write-Host "job $($dep.jobId): $status"
  if ($status -in @("SUCCEED", "FAILED", "CANCELLED")) { break }
}

[System.IO.File]::Delete($zip)
if ($status -ne "SUCCEED") { throw "deployment ended with status: $status" }
Write-Host "Deployed: https://$Branch.$AppId.amplifyapp.com/"
