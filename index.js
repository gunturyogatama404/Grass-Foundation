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
const PING_INTERVAL = 30000; // 30 segundos
const RETRY_INTERVAL = 1000; // 1 segundo de retraso para reintentos
const MAX_RETRIES = 5; // Máximo de reintentos para errores específicos

// Rutas de Archivos
const proxiesPath = path.join(__dirname, 'proxies.txt');
const usersIdPath = path.join(__dirname, 'usersId.txt');

// Variables Globales
let proxies = [];
let userIDs = [];
let activeWebSockets = [];

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

// Eliminar un proxy de la lista y actualizar proxies.txt
function removeProxy(proxy) {
  proxies = proxies.filter(p => p !== proxy);
  fs.writeFileSync(proxiesPath, proxies.join('\n'), 'utf-8');
  logger.info(`🗑️  Removed proxy from list and updated proxies.txt`);
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
        removeProxy(proxy);
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

    activeWebSockets.push(ws);

    let pingIntervalHandle = null;
    let isAuthenticated = false;
    let receivedPong = false;

    ws.on('open', () => {
      logger.info(`🔌 Opening Ws Channel with proxy ID ${sessionID}`);
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        logger.info(`📥 Message Received from server: ${JSON.stringify(message)}`);

        if (message.action === 'AUTH' && !isAuthenticated) {
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
          isAuthenticated = true;

          const pingMessage = {
            action: 'PING',
            data: {},
            id: uuidv4(),
            version: '1.0.0',
          };
          ws.send(JSON.stringify(pingMessage));
          logger.info(`📤 Message Sent to the Server: ${JSON.stringify(pingMessage)}`);
        } else if (message.action === 'PONG') {
          logger.info(`📥 Received PONG: ${JSON.stringify(message)}`);
          if (!receivedPong) {
            receivedPong = true;
            logger.info('🔄 Connection confirmed with PONG');

            pingIntervalHandle = setInterval(async () => {
              const pingMessage = {
                action: 'PING',
                data: {},
                id: uuidv4(),
                version: '1.0.0',
              };
              ws.send(JSON.stringify(pingMessage));
              logger.info(`📤 Message Sent to the Server: ${JSON.stringify(pingMessage)}`);

              // Eliminamos la verificación periódica de la IP para reducir el número de solicitudes y evitar el error 429
              /*
              try {
                const currentIPData = await getClientIP(proxy);
                if (currentIPData) {
                  logger.info(`🔍 Current Public IP via proxy ${sessionID}: ${currentIPData.ip}`);
                }
              } catch (error) {
                if (error.message.includes('ECONNREFUSED') || error.message.includes('aborted') || error.message.includes('socket hang up') || error.message.includes('timeout')) {
                  logger.warn(`⚠️  Unable to retrieve current IP via proxy ${sessionID}: ${error.message}`);
                  removeProxy(proxy);
                  ws.close();
                } else {
                  logger.warn(`⚠️  Unable to retrieve current IP via proxy ${sessionID}: ${error.message}`);
                }
              }
              */
            }, PING_INTERVAL);

            resolve();
          }
        }
      } catch (error) {
        logger.warn(`⚠️  Error processing message: ${error.message}`);
      }
    });

    ws.on('close', (code, reason) => {
      logger.warn(`🔴 WebSocket closed. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
      if (pingIntervalHandle) clearInterval(pingIntervalHandle);
      activeWebSockets = activeWebSockets.filter(socket => socket !== ws);

      // Errores donde NO se elimina el proxy y se reintenta la conexión
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
          removeProxy(proxy); // Eliminamos el proxy después de 5 reintentos fallidos
        }
      } else {
        // Errores donde SI se elimina el proxy
        logger.error(`❌ Skipping Proxy with ID: ${sessionID} due to WebSocket closed with code ${code}.`);
        removeProxy(proxy);
      }
    });

    ws.on('error', (error) => {
      logger.error(`❌ WebSocket error with proxy ID ${sessionID}: ${error.message}`);
      ws.terminate();
      if (pingIntervalHandle) clearInterval(pingIntervalHandle);
      activeWebSockets = activeWebSockets.filter(socket => socket !== ws);

      // Eliminamos el proxy en caso de error de WebSocket
      logger.error(`❌ Skipping Proxy with ID: ${sessionID} due to WebSocket error.`);
      removeProxy(proxy);
    });
  });
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
  await processProxiesInBatches(userProxyMap);
}

main().catch(error => {
  logger.error(`❌ Error in main execution: ${error.message}`);
});
