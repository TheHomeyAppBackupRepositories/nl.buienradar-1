'use strict';

const Homey = require('homey');
const Buienradar = require('./lib/buienradar');

const RAIN_THRESHOLD = 0.1;
const POLL_INTERVAL = 300000; // 5 minutes  300000
const timeMap = {
  0: 0,
  1: 5,
  2: 10,
  3: 15,
  4: 30,
  5: 45,
  6: 60,
  7: 90,
  8: 120,
};

class BuienradarApp extends Homey.App {

  async onInit() {
    this.isRaining = null;

    this.initBuienRadarLocation(); // Set location
    this.homey.geolocation.on('location', this.updateBuienRadarLocation.bind(this));

    this.initFlows(); // Initialize flows

    if (this.validLocation === true) {
      this.initBuienRadar().catch(this.error);
    }
  }

  async onUnInit() {
    this.homey.clearInterval(this.pollIntervalID);
    this.homey.clearTimeout(this.timeoutID);
  }

  /**
   * Start API instance and start polling at the next 5 minute mark.
   *
   */
  async initBuienRadar() {
    if (this.api === undefined) {
      this.api = new Buienradar();
    }
    const now = new Date();
    const timeUntilNext = new Date(Math.ceil(now / POLL_INTERVAL) * POLL_INTERVAL) - now; // Get time in ms before next 5 min mark
    this.log(`Ms untill allignment with 5 minute mark: ${timeUntilNext}`);
    await new Promise((resolve) => {
      this.timeoutID = this.homey.setTimeout(resolve, timeUntilNext);
    });

    this._pollBind = this.poll.bind(this);
    this.pollIntervalID = this.homey.setInterval(this._pollBind, POLL_INTERVAL);

    this.log('Buienradar is running...');
    await this.poll();
  }

  /**
   * Get location and validate if it is within Rainradars bounds.
   *
   */
  initBuienRadarLocation() {
    let lat = this.homey.geolocation.getLatitude();
    let lon = this.homey.geolocation.getLongitude();
    lat = Math.round(lat * 100) / 100; // round the values as rainradar only works with 2 decimals.
    lon = Math.round(lon * 100) / 100;
    this.validLocation = ((lat > 49.50 && lat < 54.80) && (lon > 0.00 && lon < 10)); // Check if location is within bounds set by Rainrader.
    if (this.validLocation === false) {
      this.log('The homey is not in the country');
      this.homey.notifications.createNotification({
        excerpt: this.homey.__('location_error'),
      });
    } else {
      this.log('The homey is in the country');
      this.lat = lat;
      this.lon = lon;
    }
  }

  /**
   * When the user updates their location update the locations for the app and validate the location.
   *
   */
  updateBuienRadarLocation() {
    let lat = this.homey.geolocation.getLatitude();
    let lon = this.homey.geolocation.getLongitude();
    lat = Math.round(lat * 100) / 100; // round the values as Rainradar only works with 2 decimals.
    lon = Math.round(lon * 100) / 100;
    const validLocationPrevious = this.validLocation;
    this.validLocation = ((lat > 49.50 && lat < 54.80) && (lon > 0.00 && lon < 10)); // Check if location is within bounds set by Rainrader.

    // Stop polling when the homey is not within bounds
    if (this.validLocation === false && validLocationPrevious === true) {
      this.log('The homey has left the country');
      this.homey.clearInterval(this.pollIntervalID);
      this.homey.clearTimeout(this.timeoutID);
      this.homey.notifications.createNotification({
        excerpt: this.homey.__('location_error'),
      });
    }
    // Change location when in bounds.
    if (this.validLocation === true) {
      this.log('Location has changed');
      this.lat = lat;
      this.lon = lon;
    }
    // Reinitialize the polling when the homey had returned within bounds and was out of bounds before.
    if (validLocationPrevious === false && this.validLocation === true) {
      this.initBuienRadar().catch(this.error);
    }
  }

  initFlows() {
    this.rainInTrigger = this.homey.flow.getTriggerCard('raining_in');
    this.rainInTrigger.registerRunListener((args, state) => {
      return args.when === state.when;
    });
    this.dryInTrigger = this.homey.flow.getTriggerCard('dry_in');
    this.dryInTrigger.registerRunListener((args, state) => {
      return args.when === state.when;
    });

    this.homey.flow.getConditionCard('is_raining').registerRunListener(async (args, state) => {
      return this.isRaining;
    });
    this.homey.flow.getConditionCard('raining_in')
      .registerRunListener(async (args, state) => {
        if (this.lastParsedForecast) {
          return this.checkIfRaining(this.lastParsedForecast[args.when]);
        }
        let forecast = await this.getForecast();
        this.lastParsedForecast = forecast;

        // Select the forecast we need
        forecast = forecast[args.when];
        return this.checkIfRaining(forecast);
      });
  }

  /**
   * Returns true is the rain threshold exceeds 0.1
   *
   * @param forecast
   * @returns {boolean}
   */
  checkIfRaining(forecast) {
    return forecast >= RAIN_THRESHOLD;
  }

  /**
   * Returns the current forecast from the api
   *
   * @returns {Promise<Error|{}>}
   */
  async getForecast() {
    // Get forecast object containing 0 - 120 minutes of rain data
    let forecast = null;
    try {
      forecast = await this.api.getForecasts(`https://br-gpsgadget.azurewebsites.net/data/raintext?lat=${this.lat}&lon=${this.lon}`);
    } catch (e) {
      this.log(`Secure API call not succeeded. Trying insecure. Error log: ${e}`);
      forecast = await this.api.getForecasts(`http://gps.buienradar.nl/getrr.php?lat=${this.lat}&lon=${this.lon}`);
    }

    if (!forecast || forecast.length === 0) {
      this.lastParsedForecast = null;

      return new Error('Could not obtain forecasts');
    }
    return this.parseForecast(forecast);
  }

  /**
   * Parses the forecast in a readable format
   *
   * @param forecast
   * @returns {{}}
   */
  parseForecast(forecast) {
    const trimmed = forecast.slice(0, 4);
    trimmed.push(forecast[6]);
    trimmed.push(forecast[9]);
    trimmed.push(forecast[12]);
    trimmed.push(forecast[18]);
    trimmed.push(forecast[23]);

    const parsed = {};
    for (let i = 0; i < trimmed.length; i++) {
      parsed[timeMap[i]] = trimmed[i].mmh;
    }

    return parsed;
  }

  /**
   * Polls the API for new information
   *
   * @returns {Promise<void>}
   */
  async poll() {
    try {
      let forecast = await this.getForecast();
      /* eslint-disable */
      for (let [when, value] of Object.entries(forecast)) {
        const raining = this.checkIfRaining(value);

        // this.log(`Forecast for: ${when}m rain: ${value}mm`);

        if (this.isRaining !== raining && when === '0') {
          if (this.isRaining !== null) { // Prevent trigger when app is started
            if (raining) {
              this.log('Raining started: NOW');
              this.homey.flow.getTriggerCard('rain_start')
                .trigger()
                .catch(this.error);
            } else {
              this.log('Raining stopped: NOW');
              this.homey.flow.getTriggerCard('rain_stop')
                .trigger()
                .catch(this.error);
            }
          }

          this.isRaining = raining;
        }
        
        if (when !== '0' &&
          when !== '5' && // 5 min is not selectable in the FLow
          this.lastParsedForecast && // Prevent triggering the Flow in reboot/update/etc
          this.lastParsedForecast[when] !== null// Skip if there was no previous forecast
        ){
          // Check if the Raining in Flow needs to be triggered
          if (raining && raining !== this.checkIfRaining(this.lastParsedForecast[when])) {
            this.log(`Rain is coming in ${when} minutes`);
            this.rainInTrigger.trigger(null, {when})
              .catch(this.error);
          }

          // Check if the Dry in Flow needs to be triggered
          if (this.isRaining && !raining && raining !== this.checkIfRaining(this.lastParsedForecast[when])) {
            this.log(`Rain is ending in ${when} minutes`);
            this.dryInTrigger.trigger(null, {when})
              .catch(this.error);
          }
        }
      }
      this.lastParsedForecast = forecast;
      forecast = null;
    } catch (error) {
      this.error(error);
    }
  }
}

module.exports = BuienradarApp;
