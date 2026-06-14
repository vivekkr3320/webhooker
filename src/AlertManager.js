'use strict';

const https = require('https');
const { URL } = require('url');
const logger = require('./logger');

/**
 * AlertManager — handles formatting and dispatching diagnostic alerts
 * to external incident management channels (Slack, PagerDuty).
 */
class AlertManager {
  /**
   * Dispatches alerts to enabled integrations.
   *
   * @param {string} orgId - Organization ID
   * @param {object} endpoint - The failing endpoint object
   * @param {object} context - Failure metadata
   * @param {number} context.failCount - Number of consecutive failures
   * @param {string} context.lastError - Error description / details
   * @param {string} context.eventName - Event/topic name
   * @param {object} context.alertConfig - Organization's alert config object
   */
  static async triggerAlert(orgId, endpoint, context) {
    const { failCount, lastError, eventName, alertConfig } = context;

    logger.info({ orgId, endpointId: endpoint.id, failCount }, 'AlertManager triggering alerts');

    const promises = [];

    // Slack Integration
    if (alertConfig.slackWebhookUrl) {
      promises.push(
        this.sendSlackAlert(alertConfig.slackWebhookUrl, endpoint, failCount, lastError, eventName)
          .catch(err => logger.error({ err: err.message, orgId }, 'Failed to dispatch Slack alert'))
      );
    }

    // PagerDuty Integration
    if (alertConfig.pagerDutyRoutingKey) {
      promises.push(
        this.sendPagerDutyAlert(alertConfig.pagerDutyRoutingKey, endpoint, failCount, lastError, eventName)
          .catch(err => logger.error({ err: err.message, orgId }, 'Failed to dispatch PagerDuty alert'))
      );
    }

    await Promise.allSettled(promises);
  }

  static sendSlackAlert(webhookUrl, endpoint, failCount, lastError, eventName) {
    return new Promise((resolve, reject) => {
      try {
        const parsedUrl = new URL(webhookUrl);
        const port = process.env.PORT || 4000;
        const dashboardUrl = process.env.DASHBOARD_URL || `http://localhost:${port}`;

        const payload = {
          text: `🚨 Webhook Alert: Endpoint '${endpoint.id}' failure threshold exceeded`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: "🚨 Webhook Failure Threshold Exceeded",
                emoji: true
              }
            },
            {
              type: "section",
              fields: [
                {
                  type: "mrkdwn",
                  text: `*Endpoint ID:*\n\`${endpoint.id}\``
                },
                {
                  type: "mrkdwn",
                  text: `*Topic/Event:*\n\`${eventName}\``
                },
                {
                  type: "mrkdwn",
                  text: `*Consecutive Failures:*\n${failCount}`
                },
                {
                  type: "mrkdwn",
                  text: `*Target URL:*\n${endpoint.url}`
                }
              ]
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Last Diagnostic Error:*\n\`\`\`${lastError}\`\`\``
              }
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "View Dashboard Logs",
                    emoji: true
                  },
                  url: dashboardUrl,
                  style: "danger"
                }
              ]
            }
          ]
        };

        const body = JSON.stringify(payload);

        const req = https.request({
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        }, (res) => {
          let respBody = '';
          res.on('data', chunk => respBody += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              logger.info({ endpointId: endpoint.id }, 'Slack alert sent successfully');
              resolve();
            } else {
              logger.error({ statusCode: res.statusCode, body: respBody }, 'Slack alert failed');
              reject(new Error(`Slack API returned status ${res.statusCode}`));
            }
          });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  static sendPagerDutyAlert(routingKey, endpoint, failCount, lastError, eventName) {
    return new Promise((resolve, reject) => {
      try {
        const payload = {
          routing_key: routingKey,
          event_action: "trigger",
          dedup_key: `alert_ep_${endpoint.id}`,
          payload: {
            summary: `Webhook endpoint '${endpoint.id}' exceeded failure threshold (${failCount} failures)`,
            source: "WebhookEngine Alerting System",
            severity: "error",
            timestamp: new Date().toISOString(),
            component: "webhook-dispatcher",
            custom_details: {
              endpointId: endpoint.id,
              url: endpoint.url,
              consecutiveFailures: failCount,
              lastError: lastError,
              eventName: eventName
            }
          }
        };

        const body = JSON.stringify(payload);

        const req = https.request({
          hostname: 'events.pagerduty.com',
          path: '/v2/enqueue',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        }, (res) => {
          let respBody = '';
          res.on('data', chunk => respBody += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              logger.info({ endpointId: endpoint.id }, 'PagerDuty alert sent successfully');
              resolve();
            } else {
              logger.error({ statusCode: res.statusCode, body: respBody }, 'PagerDuty alert failed');
              reject(new Error(`PagerDuty API returned status ${res.statusCode}`));
            }
          });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  static async sendTestAlert(config) {
    const mockEndpoint = {
      id: "test-endpoint-id",
      url: "https://example.com/webhook-receiver"
    };
    const context = {
      failCount: 1,
      lastError: "This is a simulated verification ping from the WebhookEngine alerts dashboard.",
      eventName: "system.test_ping",
      alertConfig: config
    };
    return this.triggerAlert("test-org-id", mockEndpoint, context);
  }
}

module.exports = AlertManager;
