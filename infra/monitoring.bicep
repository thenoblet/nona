// NONA'26 uptime monitoring: Azure availability tests against the live site,
// alerting by email. Lives in luxbedding-rg next to the boxes (main.bicep) and
// has its own workspace, Application Insights and action group, so nothing here
// touches CropDoor's monitoring.
//
// Cost: a standard availability test is billed per run ($0.000645 each, Oct
// 2026). 3 locations every 10 minutes is ~12,960 runs a month, about $8.40 per
// URL. Set frequencySeconds to 900 to roughly halve that.
//
// Deploy (resource-group scope):
//   az deployment group what-if --resource-group luxbedding-rg \
//     --subscription <cropdoor-prod-credits> --template-file infra/monitoring.bicep
//   az deployment group create  (same arguments)
// Turn on the worker check once the worker is deployed:
//   ... --parameters enableWorkerHealthTest=true

param location string = 'swedencentral'

@description('Where availability alerts are emailed.')
param alertEmail string = 'noblet@nobletxnancy.com'

param siteUrl string = 'https://nobletxnancy.com'

@allowed([ 300, 600, 900 ])
param frequencySeconds int = 600

@description('On since 31 Oct 2026, when the media worker went live. Set false only if the worker is retired.')
param enableWorkerHealthTest bool = true

var tags = {
  app: 'nona'
  purpose: 'wedding-2026'
  owner: 'noblet'
}

// Three European test locations. An alert needs two of them to fail, so a
// single location's network blip never pages anyone.
var testLocations = [
  { Id: 'emea-nl-ams-azr' } // West Europe
  { Id: 'emea-gb-db3-azr' } // North Europe
  { Id: 'emea-ch-zrh-edge' } // France Central
]

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'nona-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'nona-appinsights'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

resource alerts 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'nona-alerts'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'nona'
    enabled: true
    emailReceivers: [
      {
        name: 'noblet'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

var checks = concat(
  [
    {
      name: 'nona-healthz'
      title: 'NONA site health'
      path: '/api/healthz'
      // The endpoint answers {"ok":true,"version":"<sha>"}; a proxy error page
      // with a 200 would not contain this.
      contentMatch: '"ok":true'
    }
  ],
  enableWorkerHealthTest
    ? [
        {
          name: 'nona-worker-health'
          title: 'NONA media worker heartbeat'
          path: '/api/worker-health'
          // 200 while the worker's heartbeat is under 2 minutes old, 503 otherwise.
          contentMatch: ''
        }
      ]
    : []
)

resource tests 'Microsoft.Insights/webtests@2022-06-15' = [
  for c in checks: {
    name: c.name
    location: location
    tags: union(tags, {
      // Required by Application Insights: links the test to its component.
      'hidden-link:${appInsights.id}': 'Resource'
    })
    kind: 'standard'
    properties: {
      SyntheticMonitorId: c.name
      Name: c.title
      Enabled: true
      Frequency: frequencySeconds
      Timeout: 30
      Kind: 'standard'
      RetryEnabled: true
      Locations: testLocations
      Request: {
        RequestUrl: '${siteUrl}${c.path}'
        HttpVerb: 'GET'
        ParseDependentRequests: false
      }
      ValidationRules: union(
        {
          ExpectedHttpStatusCode: 200
          SSLCheck: false
        },
        empty(c.contentMatch)
          ? {}
          : {
              ContentValidation: {
                ContentMatch: c.contentMatch
                IgnoreCase: false
                PassIfTextFound: true
              }
            }
      )
    }
  }
]

resource testAlerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [
  for (c, i) in checks: {
    name: '${c.name}-down'
    location: 'global'
    tags: union(tags, {
      'hidden-link:${appInsights.id}': 'Resource'
      'hidden-link:${tests[i].id}': 'Resource'
    })
    properties: {
      description: '${c.title}: ${siteUrl}${c.path} failing from 2 or more locations'
      severity: 1
      enabled: true
      scopes: [ tests[i].id, appInsights.id ]
      evaluationFrequency: 'PT1M'
      windowSize: 'PT5M'
      criteria: {
        'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
        webTestId: tests[i].id
        componentId: appInsights.id
        failedLocationCount: 2
      }
      actions: [ { actionGroupId: alerts.id } ]
    }
  }
]
