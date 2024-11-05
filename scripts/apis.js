// scripts/apis.js

const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Lista de proveedores de IP
const ipProviders = [
  'https://ipapi.co/json/',
  'https://ipinfo.io/json',
  'http://ip-api.com/json/',
];

async function getClientIP(proxy) {
  let agent;
  if (proxy.startsWith('http://') || proxy.startsWith('https://')) {
    agent = new HttpsProxyAgent(proxy);
  } else if (proxy.startsWith('socks5://') || proxy.startsWith('socks4://')) {
    agent = new SocksProxyAgent(proxy);
  } else {
    throw new Error(`Unsupported proxy protocol: ${proxy}`);
  }

  for (let provider of ipProviders) {
    try {
      const response = await axios.get(provider, {
        httpsAgent: agent,
        timeout: 10000,
      });

      const data = response.data;

      // Dependiendo del proveedor, extraemos los datos necesarios
      let ip, city, region, country;
      if (provider.includes('ipapi.co')) {
        ip = data.ip;
        city = data.city;
        region = data.region;
        country = data.country_name;
      } else if (provider.includes('ipinfo.io')) {
        ip = data.ip;
        city = data.city;
        region = data.region;
        country = data.country;
      } else if (provider.includes('ip-api.com')) {
        ip = data.query;
        city = data.city;
        region = data.regionName;
        country = data.country;
      }

      if (!ip) {
        throw new Error(`Incomplete data received from ${provider}: ${JSON.stringify(data)}`);
      }

      const locationStr = [city, region, country].filter(Boolean).join(', ');

      return { ip, location: locationStr };
    } catch (error) {
      if (error.response && error.response.status === 429) {
        // Si recibimos un error 429, esperamos un tiempo antes de intentar con el siguiente proveedor
        await new Promise(resolve => setTimeout(resolve, 1000)); // Esperar 1 segundo
      }
      // Si es el último proveedor y aún no hemos obtenido la IP, lanzamos el error
      if (provider === ipProviders[ipProviders.length - 1]) {
        throw error;
      }
    }
  }
}

module.exports = { getClientIP };
