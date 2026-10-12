# NexaAI - desinstallation. Retire le programme et les raccourcis.
# Vos donnees (%APPDATA%\NexaAI) ne sont supprimees que si vous le confirmez.
$dest = Join-Path $env:LOCALAPPDATA "Programs\NexaAI"
foreach ($lnk in @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "NexaAI.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Programs")) "NexaAI.lnk"))) {
    Remove-Item -Force $lnk -ErrorAction SilentlyContinue
}
Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
Write-Host "NexaAI a ete desinstalle."
$data = Join-Path $env:APPDATA "NexaAI"
if (Test-Path $data) {
    $answer = Read-Host "Supprimer aussi vos donnees (conversations, memoire, gestes) dans $data ? (O/N)"
    if ($answer -match '^(o|oui|y|yes)$') {
        Remove-Item -Recurse -Force $data
        Write-Host "Donnees supprimees."
    } else {
        Write-Host "Donnees conservees."
    }
}
