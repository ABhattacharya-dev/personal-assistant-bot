$ErrorActionPreference = 'Stop'

# 1. Verify AWS CLI configuration (already done previously)
Write-Host "Verifying AWS CLI configuration..."
$caller = aws sts get-caller-identity --output json | ConvertFrom-Json
Write-Host "AWS account: $($caller.Account)"

# 2. Determine public IP
Write-Host "Detecting public IP..."
$publicIp = (Invoke-RestMethod -Uri "http://checkip.amazonaws.com").Trim()
Write-Host "Public IP: $publicIp"

# 3. Create a security group (allow inbound TCP 8080 only from your IP)
$sgName = "ollama-chat-sg"
$sgId = (aws ec2 describe-security-groups --filters Name=group-name,Values=$sgName --query "SecurityGroups[0].GroupId" --output text)
if ($sgId -eq "None") {
    Write-Host "Creating security group $sgName..."
    $sgId = aws ec2 create-security-group --group-name $sgName --description "Ollama chat app SG" --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=ollama-chat}]" --query "GroupId" --output text
    aws ec2 authorize-security-group-ingress --group-id $sgId --protocol tcp --port 8080 --cidr "${publicIp}/32"
    Write-Host "Security group $sgId created with inbound rule for $publicIp"
} else {
    Write-Host "Security group $sgId already exists. Updating inbound rule..."
    # Remove any existing rule for 8080 and add our IP
    aws ec2 revoke-security-group-ingress --group-id $sgId --protocol tcp --port 8080 --cidr "0.0.0.0/0" 2>$null
    aws ec2 authorize-security-group-ingress --group-id $sgId --protocol tcp --port 8080 --cidr "${publicIp}/32"
}

# 4. Create or reuse a key pair
$keyName = "ollama-chat-key"
$keyPath = Join-Path $PSScriptRoot "${keyName}.pem"
if (-Not (Test-Path $keyPath)) {
    Write-Host "Creating key pair $keyName..."
    $pem = aws ec2 create-key-pair --key-name $keyName --query "KeyMaterial" --output text
    $pem | Out-File -Encoding ascii -FilePath $keyPath
    icacls $keyPath /inheritance:r /grant:r "$($env:USERNAME):R"
    Write-Host "Key saved to $keyPath"
} else {
    Write-Host "Key pair file already exists at $keyPath"
}

# 5. Choose instance type (prefer m7i-flex.large)
$preferred = @("m7i-flex.large", "c7i-flex.large", "t3.small", "t3.micro")
$region = "ap-south-1"
$selectedType = $null
foreach ($type in $preferred) {
    $offering = aws ec2 describe-instance-type-offerings --region $region --location-type availability-zone --filters Name=instance-type,Values=$type --query "InstanceTypeOfferings[0].InstanceType" --output text
    if ($offering -ne "None") {
        $selectedType = $type
        break
    }
}
if (-not $selectedType) {
    Write-Error "None of the requested instance types are available in $region. Exiting."
    exit 1
}
Write-Host "Selected instance type: $selectedType"

# 6. Launch the instance with user-data script
$userDataPath = Join-Path $PSScriptRoot "instance_user_data.sh"
# Compute latest Ubuntu 22.04 LTS AMI ID for the region
$amiId = (aws ec2 describe-images --owners 099720109477 --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" --query "Images[0].ImageId" --output text)

$userDataBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($userDataPath))
$instanceTag = "ollama-chat-instance"
Write-Host "Launching EC2 instance..."
$instanceId = aws ec2 run-instances --image-id $amiId --count 1 --instance-type $selectedType --key-name $keyName --security-group-ids $sgId --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=ollama-chat},{Key=Name,Value=$instanceTag}]" --user-data $userDataBase64 --query "Instances[0].InstanceId" --output text
Write-Host "Instance ID: $instanceId"

# 7. Wait for instance to be running and obtain public DNS
Write-Host "Waiting for instance to become reachable..."
aws ec2 wait instance-status-ok --instance-ids $instanceId
$publicDns = aws ec2 describe-instances --instance-ids $instanceId --query "Reservations[0].Instances[0].PublicDnsName" --output text
Write-Host "Instance ready at: http://$publicDns:8080"

# 8. Show SSH tunnel command for Ollama API
Write-Host "To access Ollama API locally run:"
Write-Host "ssh -i $keyPath -L 11434:127.0.0.1:11434 ubuntu@$publicDns"

# 9. Run benchmark automatically (optional – runs on the instance via SSH)
Write-Host "Running benchmark (will take a few minutes)…"
ssh -i $keyPath ubuntu@$publicDns "bash -lc 'cd /home/ubuntu && ./benchmark.sh'" | Out-Host

Write-Host "Setup complete."
