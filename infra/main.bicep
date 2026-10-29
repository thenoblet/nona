// NONA'26 hosting: two VMs in the existing luxbedding-rg / lux-vnet, managed by
// LuxBedding's Dokploy on lux-01 (10.70.0.10) as remote servers.
//
//   nona-web-01  Next.js app + worker. Public IP, but the subnet NSG (lux-nsg)
//                only lets Cloudflare reach 80/443, so it is browsable only
//                through the proxied nobletxnancy.com zone.
//   nona-db-01   Postgres (a Dokploy database service). No public IP; its data
//                disk is /var/lib/docker. Its own NSG narrows who may reach it.
//
// Deploy (resource-group scope; the group, vnet, subnet and lux-nsg already exist):
//   az deployment group what-if --resource-group luxbedding-rg \
//     --subscription <cropdoor-prod-credits> --template-file infra/main.bicep \
//     --parameters infra/main.bicepparam
//   az deployment group create  (same arguments)
//
// Resize for December by changing webSize / dbSize and redeploying, or
// `az vm resize`. A resize is a reboot. The web box must stay in the Dadsv5
// family: Azure will not resize between sizes with and without a local temp disk.

param location string = 'swedencentral'
param adminUsername string = 'noblet'

@description('Public key for adminUsername on both boxes (~/.ssh/nona.pub).')
param sshPublicKey string

@description('Dadsv5 only: D2ads_v5 normally, D4ads_v5 for 4-7 Dec, D16ads_v5 for the transcode backlog.')
param webSize string = 'Standard_D2ads_v5'
param dbSize string = 'Standard_D2as_v5'

param webPrivateIp string = '10.70.0.40'
param dbPrivateIp string = '10.70.0.50'

@description('LuxBedding Dokploy (lux-01). It reaches both boxes over SSH on the private network.')
param dokployPrivateIp string = '10.70.0.10'

param dbDataDiskGb int = 64

var tags = {
  app: 'nona'
  purpose: 'wedding-2026'
  owner: 'noblet'
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: 'lux-vnet'
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'default'
}

var linuxConfig = {
  disablePasswordAuthentication: true
  ssh: {
    publicKeys: [
      {
        path: '/home/${adminUsername}/.ssh/authorized_keys'
        keyData: sshPublicKey
      }
    ]
  }
}

var ubuntu = {
  publisher: 'Canonical'
  offer: 'ubuntu-24_04-lts'
  sku: 'server'
  version: 'latest'
}

var trustedLaunch = {
  securityType: 'TrustedLaunch'
  uefiSettings: {
    secureBootEnabled: true
    vTpmEnabled: true
  }
}

// ---------------------------------------------------------------- nona-web-01

resource webPip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'nona-web-01-pip'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource webNic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: 'nona-web-01-nic'
  location: location
  tags: tags
  properties: {
    enableAcceleratedNetworking: true
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: { id: subnet.id }
          privateIPAllocationMethod: 'Static'
          privateIPAddress: webPrivateIp
          publicIPAddress: { id: webPip.id }
        }
      }
    ]
  }
}

resource web 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'nona-web-01'
  location: location
  tags: tags
  // For the Azure Blob second copy of the media (rclone with use_msi). It has no
  // role yet; one gets scoped to the backup container when that container exists.
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: webSize }
    securityProfile: trustedLaunch
    osProfile: {
      computerName: 'nona-web-01'
      adminUsername: adminUsername
      linuxConfiguration: linuxConfig
      customData: base64(loadTextContent('cloud-init/web.yaml'))
    }
    storageProfile: {
      imageReference: ubuntu
      osDisk: {
        name: 'nona-web-01-osdisk'
        createOption: 'FromImage'
        diskSizeGB: 64
        managedDisk: { storageAccountType: 'Premium_LRS' }
        deleteOption: 'Detach'
      }
    }
    networkProfile: {
      networkInterfaces: [ { id: webNic.id } ]
    }
    diagnosticsProfile: { bootDiagnostics: { enabled: true } }
  }
}

// ---------------------------------------------------------------- nona-db-01

// The subnet NSG (lux-nsg) still applies first. This one narrows the box
// further: SSH only from Dokploy and the web box (for an admin jump), Postgres
// only from the web box, and nothing else from inside the network.
resource dbNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nona-db-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-ssh-from-dokploy-and-web'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefixes: [ dokployPrivateIp, webPrivateIp ]
          sourcePortRange: '*'
          destinationAddressPrefix: dbPrivateIp
          destinationPortRange: '22'
        }
      }
      {
        name: 'allow-postgres-from-web'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: webPrivateIp
          sourcePortRange: '*'
          destinationAddressPrefix: dbPrivateIp
          destinationPortRange: '5432'
        }
      }
      // AllowVnetInBound (65000) would otherwise let every box in lux-vnet in.
      {
        name: 'deny-rest-of-vnet'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource dbNic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: 'nona-db-01-nic'
  location: location
  tags: tags
  properties: {
    enableAcceleratedNetworking: true
    networkSecurityGroup: { id: dbNsg.id }
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: { id: subnet.id }
          privateIPAllocationMethod: 'Static'
          privateIPAddress: dbPrivateIp
          // No public IP. Outbound (apt, image pulls) uses the subnet's default
          // outbound access: lux-vnet/default predates Azure's private-by-default
          // subnets. A new subnet would need a NAT gateway instead.
        }
      }
    ]
  }
}

resource dbDataDisk 'Microsoft.Compute/disks@2024-03-02' = {
  name: 'nona-db-01-data'
  location: location
  tags: tags
  sku: { name: 'Premium_LRS' }
  properties: {
    creationData: { createOption: 'Empty' }
    diskSizeGB: dbDataDiskGb
  }
}

resource db 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'nona-db-01'
  location: location
  tags: tags
  properties: {
    hardwareProfile: { vmSize: dbSize }
    securityProfile: trustedLaunch
    osProfile: {
      computerName: 'nona-db-01'
      adminUsername: adminUsername
      linuxConfiguration: linuxConfig
      customData: base64(loadTextContent('cloud-init/db.yaml'))
    }
    storageProfile: {
      imageReference: ubuntu
      osDisk: {
        name: 'nona-db-01-osdisk'
        createOption: 'FromImage'
        diskSizeGB: 32
        managedDisk: { storageAccountType: 'StandardSSD_LRS' }
        deleteOption: 'Detach'
      }
      dataDisks: [
        {
          lun: 0
          createOption: 'Attach'
          managedDisk: { id: dbDataDisk.id }
          caching: 'ReadOnly'
          deleteOption: 'Detach'
        }
      ]
    }
    networkProfile: {
      networkInterfaces: [ { id: dbNic.id } ]
    }
    diagnosticsProfile: { bootDiagnostics: { enabled: true } }
  }
}

output webPublicIp string = webPip.properties.ipAddress
output webPrivateIp string = webPrivateIp
output dbPrivateIp string = dbPrivateIp
output webPrincipalId string = web.identity.principalId
