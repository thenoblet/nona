// NONA'26 hosting: three VMs in the existing luxbedding-rg / lux-vnet, managed by
// LuxBedding's Dokploy on lux-01 (10.70.0.10) as remote servers.
//
//   nona-web-01     Next.js app. Public IP, but the subnet NSG (lux-nsg) only
//                   lets Cloudflare reach 80/443, so it is browsable only through
//                   the proxied nobletxnancy.com zone.
//   nona-db-01      Postgres (a Dokploy database service), including the pg-boss
//                   job queue. No public IP; its data disk is /var/lib/docker.
//   nona-worker-01  Media worker (thumbnails, posters, transcodes, zips). No
//                   public IP and no inbound port beyond Dokploy's SSH: it only
//                   talks OUT, to Postgres (jobs) and R2 (files). Its local temp
//                   disk is the ffmpeg scratch space.
//
// Web and worker never talk to each other directly; Postgres is the queue
// between them (pg-boss + LISTEN/NOTIFY).
//
// Deploy (resource-group scope; the group, vnet, subnet and lux-nsg already exist):
//   az deployment group what-if --resource-group luxbedding-rg \
//     --subscription <cropdoor-prod-credits> --template-file infra/main.bicep \
//     --parameters infra/main.bicepparam
//   az deployment group create  (same arguments)
//
// Resize by changing a *Size parameter and redeploying, or `az vm resize`. A
// resize is a reboot. Boxes with a local temp disk (Dadsv5: web, worker) must
// stay in that family: Azure will not resize between sizes with and without one.

param location string = 'swedencentral'
param adminUsername string = 'noblet'

@description('Public key for adminUsername on both boxes (~/.ssh/nona.pub).')
param sshPublicKey string

@description('Dadsv5 only. Stays D2ads_v5: the heavy work runs on the worker box.')
param webSize string = 'Standard_D2ads_v5'
param dbSize string = 'Standard_D2as_v5'

@description('Dadsv5 only: D4ads_v5 normally, D16ads_v5 for the post-wedding transcode backlog, then deallocate.')
param workerSize string = 'Standard_D4ads_v5'

param webPrivateIp string = '10.70.0.40'
param dbPrivateIp string = '10.70.0.50'
param workerPrivateIp string = '10.70.0.60'

@description('LuxBedding Dokploy (lux-01). It reaches every NONA box over SSH on the private network.')
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
// only from the web and worker boxes, and nothing else from inside the network.
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
        name: 'allow-postgres-from-web-and-worker'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefixes: [ webPrivateIp, workerPrivateIp ]
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

// ------------------------------------------------------------- nona-worker-01

// No public IP and no inbound service: the worker only connects OUT (Postgres
// for jobs, R2 for files, GHCR for its image). SSH only from Dokploy, plus the
// web box as an admin jump; nothing else from inside the network.
resource workerNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nona-worker-nsg'
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
          destinationAddressPrefix: workerPrivateIp
          destinationPortRange: '22'
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

resource workerNic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: 'nona-worker-01-nic'
  location: location
  tags: tags
  properties: {
    enableAcceleratedNetworking: true
    networkSecurityGroup: { id: workerNsg.id }
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: { id: subnet.id }
          privateIPAllocationMethod: 'Static'
          privateIPAddress: workerPrivateIp
          // No public IP; outbound uses the subnet's default outbound access,
          // as nona-db-01 does.
        }
      }
    ]
  }
}

resource worker 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'nona-worker-01'
  location: location
  tags: tags
  properties: {
    hardwareProfile: { vmSize: workerSize }
    securityProfile: trustedLaunch
    osProfile: {
      computerName: 'nona-worker-01'
      adminUsername: adminUsername
      linuxConfiguration: linuxConfig
      customData: base64(loadTextContent('cloud-init/worker.yaml'))
    }
    storageProfile: {
      imageReference: ubuntu
      osDisk: {
        name: 'nona-worker-01-osdisk'
        createOption: 'FromImage'
        diskSizeGB: 64
        managedDisk: { storageAccountType: 'Premium_LRS' }
        deleteOption: 'Detach'
      }
    }
    networkProfile: {
      networkInterfaces: [ { id: workerNic.id } ]
    }
    diagnosticsProfile: { bootDiagnostics: { enabled: true } }
  }
}

output webPublicIp string = webPip.properties.ipAddress
output webPrivateIp string = webPrivateIp
output dbPrivateIp string = dbPrivateIp
output workerPrivateIp string = workerPrivateIp
output webPrincipalId string = web.identity.principalId
