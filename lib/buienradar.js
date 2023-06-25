'use strict';

const fetch = require('node-fetch');
const moment = require('moment');

const TIMEOUT = 8000;
module.exports = class Buienradar {

  async getForecasts(url) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT);
    const res = await fetch(url, {
      signal: controller.signal,
    });
    clearTimeout(id);
    if (!res.ok) throw (new Error(`unexpected response: ${res.status} ${res.statusText}`));
    const text = await res.text();
    return this.constructor.parseForecast(text);
  }

  static parseForecast(text) {
    return text.split('\n')
      .filter((item) => {
        return typeof item === 'string' && item.length;
      })
      .map((item) => {
        let [mmh, time] = item.trim().split('|');
        if (typeof mmh === 'undefined' || typeof time === 'undefined') {
          throw new Error('Error parsing forecast');
        }
        // calculate value in mm/h
        mmh = parseFloat(mmh);
        mmh = 10 ** ((mmh - 109) / 32);
        mmh = Math.round(mmh * 100) / 100;

        // calculate timeSince
        const date = moment(time, 'HH:mm').toDate();

        return {
          time,
          date,
          mmh,
        };
      });
  }

};
