#!/usr/bin/env node
import { NtpPoller } from './ntp-poller';
import { average, normalizePort, stdDev, toBoolean } from './util';
// import { getNtpTime, stopNtpPolling } from './ntp';

import * as http from 'http';
import express from 'express';
import * as path from 'path';
import cookieParser from 'cookie-parser';
import logger from 'morgan';
import request from 'request';

const debug = require('debug')('express:server');

let indoorSensor: any;

if (toBoolean(process.env.HAS_INDOOR_SENSOR)) {
  indoorSensor = require('node-dht-sensor');
}

// create http server
const httpPort = normalizePort(process.env.AWC_PORT || 8080);
const app = getApp();
const httpServer = http.createServer(app);

// listen on provided ports
httpServer.listen(httpPort);

process.on('SIGTERM', () => {
  console.log('*** closing server ***');
  // httpServer.close(() => stopNtpPolling());
});

// add error handler
httpServer.on('error', onError);

// start listening on port
httpServer.on('listening', onListening);

// The DHT-22 temperature/humidity sensor appears to be prone to spurious bad readings, so we'll attempt to
// screen out the noise.

let lastTemp: number;
let lastHumidity: number;
let temps: number[] = [];
let humidities: number[] = [];
let consecutiveSensorErrors = 0;
const MAX_ERRORS = 5;
const MAX_POINTS = 10;
const sensorGpio = parseInt(process.env.SENSOR_GPIO, 10) ?? 4;
const ntpServer = process.env.AWC_NTP_SERVER ?? 'pool.ntp.org';
const ntpPoller = new NtpPoller(ntpServer);

function readSensor() {
  indoorSensor.read(22, sensorGpio, (err: any, temperature: number, humidity: number) => {
    if (err || temperature < -10 || temperature > 50 || humidity < 0 || humidity > 100)
      ++consecutiveSensorErrors;
    else {
      consecutiveSensorErrors = 0;
      temps.push(temperature);
      humidities.push(humidity);

      if (temps.length > MAX_POINTS) {
        temps.shift();
        humidities.shift();
      }

      // Report the latest temperature and humidity values that are no more than two standard deviations from the average.
      // Use the average itself in case no point matches that criterion.
      const avgTemp = average(temps);
      const sdTemp2 = stdDev(temps) * 2;

      lastTemp = avgTemp;

      for (let i = temps.length - 1; i >= 0; --i) {
        const temp = temps[i];

        if (Math.abs(temp - avgTemp) < sdTemp2) {
          lastTemp = temp;
          break;
        }
      }

      const avgHumidity = average(humidities);
      const sdHumidity2 = stdDev(humidities) * 2;

      lastHumidity = avgHumidity;

      for (let i = humidities.length - 1; i >= 0; --i) {
        const h = humidities[i];

        if (Math.abs(h - avgHumidity) < sdHumidity2) {
          lastHumidity = h;
          break;
        }
      }
    }

    if (consecutiveSensorErrors === MAX_ERRORS) {
      lastTemp = undefined;
      lastHumidity = undefined;
      temps = [];
      humidities = [];
    }

    setTimeout(readSensor, 10000);
  });
}

if (indoorSensor) {
  readSensor();
}

/**
 * Event listener for HTTP server 'error' event.
 */
function onError(error: any) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  const bind = typeof httpPort === 'string'
    ? 'Pipe ' + httpPort
    : 'Port ' + httpPort;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

/**
 * Event listener for HTTP server 'listening' event.
 */
function onListening() {
  const addr = httpServer.address();
  const bind = typeof addr === 'string'
    ? 'pipe ' + addr
    : 'port ' + addr.port;
  debug('Listening on ' + bind);
}

function getApp() {
  const theApp = express();

  theApp.use(logger(':remote-addr - :remote-user [:date[iso]] ":method :url HTTP/:http-version" :status :res[content-length] :response-time'));
  theApp.use(express.json());
  theApp.use(express.urlencoded({ extended: false }));
  theApp.use(cookieParser());
  theApp.use(express.static(path.join(__dirname, 'public')));
  theApp.get('/', (req, res) => {
    res.send('Static home file not found');
  });

  if (toBoolean(process.env.ALLOW_CORS)) {
    // see: http://stackoverflow.com/questions/7067966/how-to-allow-cors-in-express-nodejs
    theApp.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      // intercept OPTIONS method
      if ('OPTIONS' === req.method) {
        res.send(200);
      }
      else {
        next();
      }
    });
  }

  theApp.use('/darksky', (req, res) => {
    let url = `https://api.darksky.net/forecast/${process.env.DARK_SKY_API_KEY}${req.url}`;
    let frequent = false;
    const match = /(.*)(&id=)([^&]*)$/.exec(url);

    if (match) {
      url = match[1];

      if (process.env.FREQUENT_ID && match[3] === process.env.FREQUENT_ID)
        frequent = true;
    }

    req.pipe(request({
      url: url,
      qs: req.query,
      method: req.method
    }))
    .on('response', remoteRes => {
      remoteRes.headers['cache-control'] = 'max-age=' + (frequent ? '240' : '840');
    })
    .on('error', err => {
      res.status(500).send('Error connecting to Dark Sky: ' + err);
    })
    .pipe(res);
  });

  let warnIndoorNA = true;

  theApp.use('/indoor', (req, res) => {
    res.setHeader('cache-control', 'no-cache, no-store');

    if (indoorSensor) {
      if (consecutiveSensorErrors >= MAX_ERRORS || lastTemp === undefined || lastHumidity === undefined) {
        console.error('Failed to read indoor temp/humidity sensor.');
        res.json({temperature: 0, humidity: -1, error: 'Sensor error'});
      }
      else
        res.json({temperature: lastTemp, humidity: lastHumidity});
    }
    else {
      if (warnIndoorNA) {
        console.warn('Indoor temp/humidity sensor not available.');
        warnIndoorNA = false;
      }

      res.json({temperature: 0, humidity: -1, error: 'n/a'});
    }
  });

  theApp.use('/ntp', (req, res) => {
    res.setHeader('cache-control', 'no-cache, no-store');
    const time = ntpPoller.getNtpTimeInfo() as any;
    time.text = new Date(time.time).toISOString().replace('T', ' ');
    res.json(time);
  });

  return theApp;
}