param(
    [Parameter(Mandatory = $true)]
    [string] $Subscription,

    [string] $ResourceGroup = "rg-lotus-guest-atelier",
    [string] $Location = "westus2",
    [string] $ContainerAppName = "lotus-guest-atelier",
    [string] $EnvironmentName = "lotus-guest-atelier-env",
    [string] $RegistryName,
    [string] $BasicAuthUser = "guest",
    [string] $BasicAuthPassword
)

$ErrorActionPreference = "Stop"

if (-not $RegistryName) {
    $RegistryName = "lotusguestatelier$(Get-Random -Minimum 10000 -Maximum 99999)"
}

if (-not $BasicAuthPassword) {
    $chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#%+=".ToCharArray()
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 24
    $rng.GetBytes($bytes)
    $BasicAuthPassword = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

az account set --subscription $Subscription

foreach ($namespace in @("Microsoft.App", "Microsoft.ContainerRegistry", "Microsoft.OperationalInsights")) {
    $state = az provider show --namespace $namespace --query registrationState -o tsv 2>$null
    if ($state -ne "Registered") {
        az provider register --namespace $namespace --wait
    }
}

az group create --name $ResourceGroup --location $Location
az acr create --name $RegistryName --resource-group $ResourceGroup --sku Basic --admin-enabled true
az acr build --registry $RegistryName --image "$ContainerAppName`:latest" .
az containerapp env create --name $EnvironmentName --resource-group $ResourceGroup --location $Location

$registryUser = az acr credential show --name $RegistryName --query username -o tsv
$registryPassword = az acr credential show --name $RegistryName --query "passwords[0].value" -o tsv

$fqdn = az containerapp create `
    --name $ContainerAppName `
    --resource-group $ResourceGroup `
    --environment $EnvironmentName `
    --image "$RegistryName.azurecr.io/$ContainerAppName`:latest" `
    --ingress external `
    --target-port 8080 `
    --registry-server "$RegistryName.azurecr.io" `
    --registry-username $registryUser `
    --registry-password $registryPassword `
    --secrets "basic-auth-password=$BasicAuthPassword" `
    --env-vars "BASIC_AUTH_USER=$BasicAuthUser" "BASIC_AUTH_PASSWORD=secretref:basic-auth-password" `
    --query "properties.configuration.ingress.fqdn" `
    -o tsv

[pscustomobject]@{
    Url = "https://$fqdn"
    Username = $BasicAuthUser
    Password = $BasicAuthPassword
    Subscription = $Subscription
    ResourceGroup = $ResourceGroup
    ContainerApp = $ContainerAppName
    ContainerRegistry = $RegistryName
} | Format-List
