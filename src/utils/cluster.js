import https from 'node:https';
import cluster from 'node:cluster';
import { timeDifference } from './util.js';
import { log, logError } from '../helpers/logger.js';

const counts = {
  requestCount: 0,
  customRequestCount: 0,
};

function formatRequestDataForNotification(requestData) {
  const parts = [];

  if (requestData.method) parts.push(`Method: ${requestData.method}`);
  if (requestData.originalUrl || requestData.path) {
    parts.push(`URL: ${requestData.originalUrl || requestData.path}`);
  }
  if (requestData.ip) parts.push(`IP: ${requestData.ip}`);
  if (requestData.userAgent) parts.push(`User-Agent: ${requestData.userAgent}`);
  if (requestData.query && Object.keys(requestData.query).length > 0) {
    parts.push(`Query: ${JSON.stringify(requestData.query)}`);
  }
  if (requestData.params && Object.keys(requestData.params).length > 0) {
    parts.push(`Params: ${JSON.stringify(requestData.params)}`);
  }
  if (requestData.body && Object.keys(requestData.body).length > 0) {
    const bodyStr = JSON.stringify(requestData.body);
    // Limit body size in notification
    const maxBodyLength = 200;
    parts.push(`Body: ${bodyStr.length > maxBodyLength ? bodyStr.substring(0, maxBodyLength) + '...' : bodyStr}`);
  }
  if (requestData.referer) parts.push(`Referer: ${requestData.referer}`);
  if (requestData.timestamp) parts.push(`Time: ${requestData.timestamp}`);

  return parts.join('\n');
}

export const sendWorkedDiedPushNotification = (workerId, errorDetails, requestData = null) => {
  const { PUSHOVER_USER_KEY, PUSHOVER_API_TOKEN } = process.env;
  if (!PUSHOVER_USER_KEY || !PUSHOVER_API_TOKEN) return;

  const errorSummary = (errorDetails || '').split('\n')[0] || 'Unknown error';
  let message = `Worker with ID ${workerId} has died.\n\nError: ${errorSummary}`;

  // Add request data if available
  if (requestData) {
    const requestInfo = formatRequestDataForNotification(requestData);
    message += `\n\nRequest Details:\n${requestInfo}`;
  }

  // Pushover has a 1024 character limit, truncate if needed
  if (message.length > 1024) {
    const truncatedMessage = message.substring(0, 1024 - 3);
    message = `${truncatedMessage}...`;
  }

  const postData = JSON.stringify({
    token: PUSHOVER_API_TOKEN,
    user: PUSHOVER_USER_KEY,
    title: `Cluster Alert: Worker ${workerId} Died`,
    message,
  });

  const options = {
    hostname: 'api.pushover.net',
    port: 443,
    path: '/1/messages.json',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': postData.length,
    },
  };

  const req = https.request(options, res => {
    res.on('data', d => {
      process.stdout.write(d);
      log('Notification sent!');
    });
  });

  req.on('error', e => {
    logError('Error sending notification', { error: e });
  });

  req.write(postData);
  req.end();
};

export const handleClusterExit = (worker, code, signal) => {
  let reason;

  if (signal) {
    reason = `Worker was killed by signal: ${signal}`;
  } else if (code !== 0) {
    reason = `Worker exited with error code: ${code}`;
  } else {
    reason = 'Worker exited successfully';
  }

  log(`[Master] ${worker.process.pid} died. ${reason}`);

  cluster.fork();
};

export const handleClusterMessage = (worker, message) => {
  if (message.type === 'request_counts') {
    counts.requestCount += message.requestCount || 0;
    counts.customRequestCount += message.customRequestCount || 0;
  }

  if (message.type === 'error') {
    log(`[Master] Received error from worker ${worker.process.pid}: ${message.error}`);
    sendWorkedDiedPushNotification(
      worker.process.pid,
      message.error || 'No error details',
      message.requestData || null
    );
  }
};

export const logCounts = () => {
  const startTime = Date.now();

  setInterval(() => {
    const diff = timeDifference(startTime, Date.now());

    log(`[Count] ${counts.requestCount} requests in ${diff}`);
    log(`[Count] ${counts.customRequestCount} custom requests in ${diff}`);
  }, 30 * 1000 /* 30 seconds */);
};
