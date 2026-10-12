# NexaAI - installation sous Windows (lancee par installer_nexaai.bat)
# - copie NexaAI dans %LOCALAPPDATA%\Programs\NexaAI
# - verifie Python 3.10+ et Ollama ; propose de les installer avec winget (avec votre accord)
# - cree les raccourcis Bureau et menu Demarrer
# Vos donnees (conversations, memoire...) restent dans %APPDATA%\NexaAI.

$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA "Programs\NexaAI"

function Ask($question) {
    $answer = Read-Host "$question (O/N)"
    return $answer -match '^(o|oui|y|yes)$'
}

function Find-Python {
    # Renvoie la commande a utiliser ("py" ou "python") si Python 3.10+ est disponible.
    $check = "import sys; print(sys.version_info >= (3, 10))"
    if (Get-Command py -ErrorAction SilentlyContinue) {
        try { if ((& py -3 -c $check 2>$null) -eq "True") { return "py" } } catch { }
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        try { if ((& python -c $check 2>$null) -eq "True") { return "python" } } catch { }
    }
    return $null
}

Write-Host ""
Write-Host "=== Installation de NexaAI ===" -ForegroundColor Magenta
Write-Host "Dossier d'installation : $dest"
Write-Host ""

# 1. Python ---------------------------------------------------------------
$python = Find-Python
if (-not $python) {
    Write-Host "Python 3.10 ou plus recent est introuvable." -ForegroundColor Yellow
    if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Ask "Installer Python 3.12 maintenant avec winget ?")) {
        winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
        $python = Find-Python
    }
    if (-not $python) {
        Write-Host "Installez Python depuis https://www.python.org/downloads/ (cochez 'Add python.exe to PATH'), puis relancez l'installation." -ForegroundColor Red
        exit 1
    }
}
Write-Host "[OK] Python detecte ($python)" -ForegroundColor Green

# 2. Copie des fichiers -----------------------------------------------------
if (Test-Path $dest) {
    Write-Host "Une version precedente est presente : elle va etre remplacee (vos donnees sont conservees)."
    Remove-Item -Recurse -Force (Join-Path $dest "nexaai"), (Join-Path $dest "web") -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($item in @("nexaai", "web", "docs", "start_nexaai.bat", "README.md")) {
    Copy-Item -Recurse -Force (Join-Path $src $item) $dest
}
Copy-Item -Force (Join-Path $src "scripts\uninstall_windows.ps1") $dest
Get-ChildItem -Path $dest -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
Write-Host "[OK] Fichiers copies" -ForegroundColor Green

# 3. Raccourcis ----------------------------------------------------------------
$shell = New-Object -ComObject WScript.Shell
$targets = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "NexaAI.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Programs")) "NexaAI.lnk")
)
foreach ($lnk in $targets) {
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath = Join-Path $dest "start_nexaai.bat"
    $s.WorkingDirectory = $dest
    $s.IconLocation = (Join-Path $dest "web\nexaai.ico") + ",0"
    $s.WindowStyle = 7          # console reduite
    $s.Description = "NexaAI - assistant personnel"
    $s.Save()
}
Write-Host "[OK] Raccourcis crees (Bureau et menu Demarrer)" -ForegroundColor Green

# 4. Ollama (moteur local, facultatif mais recommande) ----------------------------
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
    $candidate = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
    if (Test-Path $candidate) { $ollama = $candidate }
}
if (-not $ollama) {
    Write-Host ""
    Write-Host "Ollama (moteur d'IA local et gratuit) n'est pas installe." -ForegroundColor Yellow
    if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Ask "Installer Ollama maintenant avec winget ?")) {
        winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements
        $candidate = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
        if (Test-Path $candidate) { $ollama = $candidate }
    } else {
        Write-Host "Vous pourrez l'installer plus tard depuis https://ollama.com/download"
    }
}
if ($ollama) {
    Write-Host "[OK] Ollama detecte" -ForegroundColor Green
    $models = & $ollama list 2>$null
    if (-not ($models -match "llama3.2")) {
        if (Ask "Telecharger le modele llama3.2 (environ 2 Go, recommande pour debuter) ?") {
            & $ollama pull llama3.2
        }
    }
}

Write-Host ""
Write-Host "=== NexaAI est installe ===" -ForegroundColor Magenta
Write-Host "Lancez-le avec l'icone NexaAI du Bureau ou du menu Demarrer."
if (Ask "Lancer NexaAI maintenant ?") {
    Start-Process -FilePath (Join-Path $dest "start_nexaai.bat") -WorkingDirectory $dest -WindowStyle Minimized
}
