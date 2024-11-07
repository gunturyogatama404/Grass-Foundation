// index.js

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const { getClientIP } = require('./scripts/apis');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const limit = require('promise-limit');
const clear = require('console-clear');
const figlet = require('figlet');

// Limpiar la consola
clear();

// Mostrar la presentación en color verde
console.log('\x1b[32m%s\x1b[0m', figlet.textSync('GRASS BOT', { horizontalLayout: 'full' }));

// Mostrar los mensajes de bienvenida en color verde
console.log('\x1b[32m%s\x1b[0m', '👋 Hello! Welcome to Grass Foundation AutoFarming Bot');
console.log('\x1b[32m%s\x1b[0m', '🤝 This tool was created by Naeaex inspired by dante4rt from HCA Community');

// Configuración del Logger de Winston
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ level, timestamp, message }) => {
      let coloredLevelTimestamp;
      switch (level) {
        case 'info':
          coloredLevelTimestamp = `\x1b[34m[INFO] [${timestamp}]\x1b[0m`; // Azul
          break;
        case 'warn':
          coloredLevelTimestamp = `\x1b[33m[WARN] [${timestamp}]\x1b[0m`; // Amarillo
          break;
        case 'error':
          coloredLevelTimestamp = `\x1b[31m[ERROR] [${timestamp}]\x1b[0m`; // Rojo
          break;
        default:
          coloredLevelTimestamp = `[${level.toUpperCase()}] [${timestamp}]`;
      }
      return `${coloredLevelTimestamp}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console()
  ],
});

// Constantes de Configuración
const WSS_URL = 'wss://proxy2.wynd.network:4650/';
const AUTH_ORIGIN = 'chrome-extension://ilehaonighjijnmpnagapkhpcdbhclfg';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const PING_INTERVAL = 5000;
const RETRY_INTERVAL = 1000;
const MAX_RETRIES = 5;
const MIN_CONNECTIONS_PER_USER = 40; // Min devices connected per user (changeable)
const MAX_CONNECTIONS_PER_USER = 70; // Max devices connected per user (changeable)

// Rutas de Archivos
const proxiesPath = path.join(__dirname, 'proxies.txt');
const usersIdPath = path.join(__dirname, 'usersId.txt');

// Variables Globales
let proxies = [];
let userIDs = [];
let activeWebSockets = [];
let failedProxies = new Set(); // Conjunto para almacenar proxies fallidos temporalmente

// Cargar proxies desde proxies.txt
function loadProxies() {
  try {
    const data = fs.readFileSync(proxiesPath, 'utf-8');
    proxies = data.split('\n').map(line => line.trim()).filter(Boolean);
    logger.info(`📄 Loaded ${proxies.length} proxies from proxies.txt`);
  } catch (error) {
    logger.error(`❌ Error reading proxies.txt: ${error.message}`);
    process.exit(1);
  }
}

// Cargar IDs de usuarios desde usersId.txt
function loadUserIDs() {
  try {
    const data = fs.readFileSync(usersIdPath, 'utf-8');
    userIDs = data.split('\n').map(line => line.trim()).filter(Boolean);
    if (userIDs.length === 0) {
      logger.error('❌ No user IDs found in usersId.txt');
      process.exit(1);
    }
    logger.info(`📄 Loaded ${userIDs.length} user IDs from usersId.txt`);
  } catch (error) {
    logger.error(`❌ Error reading usersId.txt: ${error.message}`);
    process.exit(1);
  }
}

// Extraer ID de sesión del login del proxy
function extractSessionID(login) {
  const regex = /session-([A-Za-z0-9]+)-sessTime-/;
  const match = login.match(regex);
  return match ? match[1] : 'Unknown';
}

// Obtener el agente de proxy adecuado según el protocolo
function getAgent(proxy) {
  if (proxy.startsWith('http://') || proxy.startsWith('https://')) {
    return new HttpsProxyAgent(proxy);
  } else if (proxy.startsWith('socks5://') || proxy.startsWith('socks4://')) {
    return new SocksProxyAgent(proxy);
  } else {
    logger.error(`❌ Unsupported proxy protocol: ${proxy}`);
    return null;
  }
}

// Marcar un proxy como fallido temporalmente
function markProxyAsFailed(proxy) {
  failedProxies.add(proxy);
  // Reintentar después de un intervalo
  setTimeout(() => {
    failedProxies.delete(proxy);
  }, RETRY_INTERVAL * MAX_RETRIES);
}

// Establecer una conexión WebSocket usando el proxy y user ID especificados
function connectWebSocket(proxy, userID, retryCounts = {}) {
  return new Promise(async (resolve, reject) => {
    const agent = getAgent(proxy);
    if (!agent) {
      return reject(new Error('Invalid agent'));
    }

    const proxyLogin = proxy.split('@')[0];
    const sessionID = extractSessionID(proxyLogin);

    logger.info(`🔗 Connecting to Proxy with ID: ${sessionID}`);

    try {
      const ipData = await getClientIP(proxy);
      if (ipData) {
        const { ip } = ipData;
        logger.info(`🔍 Public IP Retrieved: ${ip}`);
      }
    } catch (error) {
      if (
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('aborted') ||
        error.message.includes('socket hang up') ||
        error.message.includes('timeout') ||
        error.message.includes('Request failed with status code 429')
      ) {
        logger.warn(`⚠️  Unable to retrieve IP data for Proxy with ID: ${sessionID}: ${error.message}`);
        markProxyAsFailed(proxy);
        return reject(new Error('Invalid proxy'));
      } else {
        logger.warn(`⚠️  Unable to retrieve IP data for Proxy with ID: ${sessionID}: ${error.message}`);
      }
    }

    const headers = {
      Host: 'proxy2.wynd.network:4650',
      Connection: 'Upgrade',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      'User-Agent': USER_AGENT,
      Upgrade: 'websocket',
      Origin: AUTH_ORIGIN,
      'Sec-WebSocket-Version': '13',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-WebSocket-Key': uuidv4().replace(/-/g, '') + '==',
      'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
    };

    const ws = new WebSocket(WSS_URL, {
      headers,
      agent,
      rejectUnauthorized: false,
    });

    ws.sessionID = sessionID;
    ws.userID = userID;
    ws.isAuthenticated = false;
    ws.pingIntervalHandle = null;
    ws.pongReceived = true;

    activeWebSockets.push(ws);

    ws.on('open', () => {
      logger.info(`🔌 Opening Ws Channel with proxy ID ${sessionID}`);
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        logger.info(`📥 Message Received from server: ${JSON.stringify(message)}`);

        if (message.action === 'AUTH' && !ws.isAuthenticated) {
          const authResponse = {
            id: message.id,
            origin_action: 'AUTH',
            result: {
              browser_id: uuidv4(),
              user_id: userID,
              user_agent: USER_AGENT,
              timestamp: Math.floor(Date.now() / 1000),
              device_type: 'extension',
              extension_id: 'ilehaonighjijnmpnagapkhpcdbhclfg',
              version: '4.26.2',
            },
          };

          ws.send(JSON.stringify(authResponse));
          logger.info(`📤 Message Sent to the Server: ${JSON.stringify(authResponse)}`);
          logger.info('🛡️  Authentication Successful');
          ws.isAuthenticated = true;

          // Enviar el primer PING inmediatamente después de la autenticación
          sendPing(ws);

          resolve();
        } else if (message.action === 'PONG') {
          logger.info(`📥 Received PONG: ${JSON.stringify(message)}`);
          ws.pongReceived = true; // Confirmar recepción de PONG
        }
      } catch (error) {
        logger.warn(`⚠️  Error processing message: ${error.message}`);
      }
    });

    ws.on('close', (code, reason) => {
      logger.warn(`🔴 WebSocket closed. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
      if (ws.pingIntervalHandle) clearInterval(ws.pingIntervalHandle);
      activeWebSockets = activeWebSockets.filter(socket => socket !== ws);

      // Errores donde NO se omite el proxy y se reintenta la conexión
      if (
        (code === 1005 && !reason) ||
        (code === 1006 && (!reason || reason === 'ngguy')) ||
        (code === 4000 && reason === 'nggyu')
      ) {
        const key = `code_${code}_${sessionID}`;
        retryCounts[key] = (retryCounts[key] || 0) + 1;
        if (retryCounts[key] <= MAX_RETRIES) {
          setTimeout(() => {
            logger.info(`🔁 Retrying connection for proxy ID: ${sessionID} (Attempt ${retryCounts[key]}/${MAX_RETRIES})`);
            connectWebSocket(proxy, userID, retryCounts).catch(() => {});
          }, RETRY_INTERVAL);
        } else {
          logger.error(`❌ Skipping Proxy with ID: ${sessionID} after ${MAX_RETRIES} retries due to WebSocket closed with code ${code} and reason '${reason}'.`);
          // En lugar de eliminar el proxy, lo marcamos como fallido temporalmente
          markProxyAsFailed(proxy);
        }
      } else {
        // Otros errores: simplemente omitimos el proxy sin eliminarlo
        logger.warn(`⚠️  WebSocket closed with code ${code} and reason '${reason}'. Proxy ID: ${sessionID} will be reused.`);
      }
    });

    ws.on('error', (error) => {
      logger.error(`❌ WebSocket error with proxy ID ${sessionID}: ${error.message}`);
      ws.terminate();
      if (ws.pingIntervalHandle) clearInterval(ws.pingIntervalHandle);
      activeWebSockets = activeWebSockets.filter(socket => socket !== ws);

      // Omitir el proxy y marcarlo como fallido temporalmente
      markProxyAsFailed(proxy);
    });

    ws.on('pong', () => {
      // Confirmar recepción de PONG
      ws.pongReceived = true;
    });
  });
}

// Función para enviar PING y verificar PONG
function sendPing(ws) {
  if (ws.readyState === WebSocket.OPEN) {
    if (!ws.pongReceived) {
      logger.warn(`⚠️  No PONG received from proxy ID ${ws.sessionID}. Terminating connection.`);
      ws.terminate(); // Terminar la conexión si no se recibió PONG
      return;
    }

    const pingMessage = {
      action: 'PING',
      data: {},
      id: uuidv4(),
      version: '1.0.0',
    };
    ws.send(JSON.stringify(pingMessage));
    logger.info(`📤 PING sent to the Server: ${JSON.stringify(pingMessage)}`);
    ws.pongReceived = false; // Esperando PONG

    // Programar el siguiente PING
    ws.pingIntervalHandle = setTimeout(() => {
      sendPing(ws);
    }, PING_INTERVAL);
  }
}

// Función para procesar los proxies de los usuarios en lotes de 5, rotando entre cuentas
async function processProxiesInBatches(userProxyMap) {
  const batchSize = 5;
  let proxiesLeft = true;

  while (proxiesLeft) {
    proxiesLeft = false;
    for (let userID of userIDs) {
      const userProxies = userProxyMap[userID];
      if (userProxies && userProxies.length > 0) {
        proxiesLeft = true;
        const batch = userProxies.splice(0, batchSize);
        const batchLimiter = limit(5); // Procesamos hasta 5 proxies en paralelo por usuario

        await Promise.all(
          batch.map(proxy => batchLimiter(() => connectWebSocket(proxy, userID).catch(() => {})))
        );
      }
    }
  }
}

// Función para mantener el número de conexiones por usuario
async function maintainConnections(userProxyMap) {
  while (true) {
    for (let userID of userIDs) {
      const currentConnections = activeWebSockets.filter(ws => ws.userID === userID && ws.isAuthenticated).length;
      const requiredConnections = Math.min(Math.max(MIN_CONNECTIONS_PER_USER - currentConnections, 0), MAX_CONNECTIONS_PER_USER - currentConnections);
      const availableProxies = userProxyMap[userID] ? userProxyMap[userID].filter(p => !failedProxies.has(p)) : [];

      for (let i = 0; i < requiredConnections && availableProxies.length > 0; i++) {
        const proxy = availableProxies.shift();
        userProxyMap[userID] = userProxyMap[userID].filter(p => p !== proxy); // Remover proxy asignado
        connectWebSocket(proxy, userID).catch(() => {
          // Si falla, se reinyecta el proxy para reintentar
          userProxyMap[userID].push(proxy);
        });
      }

      // Asegurar que no excedemos el máximo de conexiones
      const totalConnections = activeWebSockets.filter(ws => ws.userID === userID && ws.isAuthenticated).length;
      if (totalConnections < MIN_CONNECTIONS_PER_USER && userProxyMap[userID].length === 0) {
        logger.warn(`⚠️  Not enough proxies to maintain the minimum connections for user ID: ${userID}`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 5000)); // Esperar 5 segundos antes de verificar nuevamente
  }
}

// Función principal para inicializar la aplicación
async function main() {
  loadProxies();
  loadUserIDs();

  if (userIDs.length === 0) {
    logger.error('❌ No user IDs available to authenticate.');
    process.exit(1);
  }

  // Asignar los proxies a los usuarios en orden, rotando
  let userProxyMap = {};
  let userIndex = 0;
  for (let proxy of proxies) {
    const userID = userIDs[userIndex % userIDs.length];
    if (!userProxyMap[userID]) {
      userProxyMap[userID] = [];
    }
    userProxyMap[userID].push(proxy);
    userIndex++;
  }

  // Procesar los proxies en lotes de 5 por usuario, rotando entre cuentas
  processProxiesInBatches(userProxyMap).catch(error => {
    logger.error(`❌ Error in batch processing: ${error.message}`);
  });

  // Mantener el número de conexiones por usuario
  maintainConnections(userProxyMap).catch(error => {
    logger.error(`❌ Error in maintaining connections: ${error.message}`);
  });
}

main().catch(error => {
  logger.error(`❌ Error in main execution: ${error.message}`);
});
