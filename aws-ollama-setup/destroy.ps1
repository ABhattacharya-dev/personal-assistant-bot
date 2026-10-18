$ErrorActionPreference = 'Stop'

$region = "ap-south-1"
$tagName = "ollama-chat-project"
$sgName = "ollama-chat-sg"
$keyName = "ollama-chat-key"

Write-Host "Tearing down AWS Ollama Chat resources in $region..." -ForegroundColor Yellow

# 1. Terminate EC2 instances tagged with project
$instIds = (aws ec2 describe-instances --region $region `
    --filters "Name=tag:Project,Values=$tagName" "Name=instance-state-name,Values=pending,running,stopped,stopping" `
    --query "Reservations[].Instances[].InstanceId" --output text).Trim()

if ($instIds) {
    Write-Host "Terminating instance(s): $instIds"
    aws ec2 terminate-instances --region $region --instance-ids ($instIds -split '\s+') | Out-Null
    Write-Host "Waiting for instance(s) to terminate..."
    aws ec2 wait instance-terminated --region $region --instance-ids ($instIds -split '\s+')
    Write-Host "Instance(s) terminated." -ForegroundColor Green
} else {
    Write-Host "No active instances found."
}

# 2. Delete Security Group
$sgId = (aws ec2 describe-security-groups --region $region --filters "Name=group-name,Values=$sgName" --query "SecurityGroups[0].GroupId" --output text).Trim()
if ($sgId -and $sgId -ne "None") {
    Write-Host "Deleting security group $sgId..."
    aws ec2 delete-security-group --region $region --group-id $sgId
    Write-Host "Security group deleted." -ForegroundColor Green
}

# 3. Delete Key Pair
Write-Host "Deleting key pair $keyName..."
aws ec2 delete-key-pair --region $region --key-name $keyName | Out-Null
$keyPath = Join-Path $PSScriptRoot "ollama-chat-key.pem"
if (Test-Path $keyPath) {
    Remove-Item $keyPath -Force
    Write-Host "Removed local key file: $keyPath" -ForegroundColor Green
}

Write-Host "Teardown complete. No stray AWS resources remain." -ForegroundColor Green
