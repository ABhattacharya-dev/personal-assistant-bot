$ErrorActionPreference = 'Stop'

param(
    [string]$instanceIp = "13.201.33.5",
    [string]$keyPath = "$PSScriptRoot\..\aws-ollama-setup\ollama-chat-key.pem",
    [string]$remoteDir = "/home/ubuntu/personal-assistant"
)

$rootDir = (Resolve-Path "$PSScriptRoot\..").Path

Write-Host "=== Deploying Personal Assistant to EC2 ($instanceIp) ===" -ForegroundColor Cyan

# 1. Create remote directories
ssh -i $keyPath -o StrictHostKeyChecking=no ubuntu@$instanceIp "mkdir -p $remoteDir/src/public $remoteDir/src/core $remoteDir/src/database $remoteDir/src/adapters $remoteDir/test $remoteDir/scripts /home/ubuntu/assistant-data/backups"

# 2. Sync files via SCP
Write-Host "Copying application files..." -ForegroundColor Yellow
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\package.json" ubuntu@${instanceIp}:${remoteDir}/package.json
if (Test-Path "$rootDir\.env") {
    scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\.env" ubuntu@${instanceIp}:${remoteDir}/.env
} else {
    scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\.env.example" ubuntu@${instanceIp}:${remoteDir}/.env
}
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\index.js" ubuntu@${instanceIp}:${remoteDir}/src/index.js
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\config.js" ubuntu@${instanceIp}:${remoteDir}/src/config.js

# Database files
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\database\db.js" ubuntu@${instanceIp}:${remoteDir}/src/database/db.js
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\database\expenseRepo.js" ubuntu@${instanceIp}:${remoteDir}/src/database/expenseRepo.js
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\database\reminderRepo.js" ubuntu@${instanceIp}:${remoteDir}/src/database/reminderRepo.js
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\database\memoryRepo.js" ubuntu@${instanceIp}:${remoteDir}/src/database/memoryRepo.js
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\database\userRepo.js" ubuntu@${instanceIp}:${remoteDir}/src/database/userRepo.js

# Core files
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\core\assistant.js" ubuntu@${instanceIp}:${remoteDir}/src/core/assistant.js
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\core\intentRouter.js" ubuntu@${instanceIp}:${remoteDir}/src/core/intentRouter.js
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\core\modelClient.js" ubuntu@${instanceIp}:${remoteDir}/src/core/modelClient.js
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\core\scheduler.js" ubuntu@${instanceIp}:${remoteDir}/src/core/scheduler.js

# Adapters & Public UI
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\adapters\webAdapter.js" ubuntu@${instanceIp}:${remoteDir}/src/adapters/webAdapter.js
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\src\public\index.html" ubuntu@${instanceIp}:${remoteDir}/src/public/index.html

# Tests & Scripts
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\test\testCases.json" ubuntu@${instanceIp}:${remoteDir}/test/testCases.json
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\test\run_suite.js" ubuntu@${instanceIp}:${remoteDir}/test/run_suite.js
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\scripts\backup_db.sh" ubuntu@${instanceIp}:${remoteDir}/scripts/backup_db.sh
scp -i $keyPath -o StrictHostKeyChecking=no "$rootDir\scripts\update_service.sh" ubuntu@${instanceIp}:${remoteDir}/scripts/update_service.sh

# 3. Install packages and set up assistant.service on EC2
Write-Host "Configuring systemd service on EC2..." -ForegroundColor Yellow
ssh -i $keyPath -o StrictHostKeyChecking=no ubuntu@$instanceIp "sudo systemctl stop chat-app || true; cd $remoteDir && npm install --production && chmod +x scripts/*.sh && sudo bash -c 'cat > /etc/systemd/system/assistant.service <<EOF
[Unit]
Description=Personal Assistant Service
After=network.target ollama.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=$remoteDir
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=DB_PATH=/home/ubuntu/assistant-data/assistant.db
Environment=BACKUP_DIR=/home/ubuntu/assistant-data/backups
Environment=MODEL_BASE_URL=http://127.0.0.1:11434/v1
Environment=MODEL_NAME=qwen2.5:3b
Environment=MODEL_API_KEY=ollama
ExecStart=/usr/bin/node $remoteDir/src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable assistant.service
systemctl restart assistant.service
systemctl status assistant.service --no-pager
'"

Write-Host "`n Deployment complete! Open http://${instanceIp}:8080" -ForegroundColor Green
