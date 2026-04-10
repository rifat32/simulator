const fs = require("fs");
const path = require("path");
const { DashcamSimulator } = require("./devices/dashcam");
const { OBD2Simulator } = require("./devices/obd2");
const { TrackerSimulator } = require("./devices/tracker");
const logger = require("./utils/logger");

const SERVER_HOST = process.env.SERVER_HOST || "54.37.225.65";
const PORTS = { DASHCAM: 4017, OBD2: 4030, TRACKER: 5004 };

// Parse CLI Arguments
const args = process.argv.slice(2).reduce((acc, arg) => {
  let [key, value] = arg.split("=");
  key = key.replace("--", "");
  if (value === "true") value = true;
  else if (value === "false") value = false;
  else if (!isNaN(value)) value = parseInt(value, 10);
  acc[key] = value;
  return acc;
}, {});

// Configuration with Defaults
const config = {
  vehicles: args.vehicles !== undefined ? args.vehicles : 10,
  gpsInterval: args["gps-interval"] || 20,
  obdInterval: args["obd-interval"] || 15,

  // Dashcam AI Incidents
  incidentChance:
    args["incident-chance"] !== undefined ? args["incident-chance"] : 100,
  incidentInterval: args["incident-interval"] || 10,

  // OBD2 Engine Faults (DTC)
  dtcChance: args["dtc-chance"] !== undefined ? args["dtc-chance"] : 5,
  dtcInterval: args["dtc-interval"] || 60,

  enableDashcam:
    args["enable-dashcam"] !== undefined ? args["enable-dashcam"] : true,
  enableObd: args["enable-obd"] !== undefined ? args["enable-obd"] : true,
  enableTracker:
    args["enable-tracker"] !== undefined ? args["enable-tracker"] : true,

  enableGps: args["enable-gps"] !== undefined ? args["enable-gps"] : true,
  enableIncidents:
    args["enable-incidents"] !== undefined ? args["enable-incidents"] : true,
  enableVideo: args["enable-video"] !== undefined ? args["enable-video"] : true,
  enableLiveStream:
    args["enable-live-stream"] !== undefined
      ? args["enable-live-stream"]
      : true,
};

// Validation
if (!config.enableDashcam && !config.enableObd && !config.enableTracker) {
  console.error("[ERROR] At least one device type must be enabled.");
  process.exit(1);
}
if (config.vehicles < 1 || config.vehicles > 150) {
  console.error(
    `[ERROR] Invalid vehicles count: ${config.vehicles} (must be 1-150)`,
  );
  process.exit(1);
}
["gpsInterval", "obdInterval", "incidentInterval"].forEach((key) => {
  if (config[key] < 5 || config[key] > 3600) {
    console.error(`[ERROR] Invalid ${key}: ${config[key]}s (must be 5-3600)`);
    process.exit(1);
  }
});

// Load Devices
let deviceDb;
try {
  const dbPath = path.join(__dirname, "data", "devices.json");
  deviceDb = JSON.parse(fs.readFileSync(dbPath, "utf8"));
} catch (err) {
  console.error(`[ERROR] Could not read data/devices.json: ${err.message}`);
  process.exit(1);
}

if (config.vehicles > deviceDb.length) {
  console.error(
    `[ERROR] Requested ${config.vehicles} vehicles but devices.json only has ${deviceDb.length} entries.`,
  );
  process.exit(1);
}

const activeDevicesPerVehicle = [
  config.enableDashcam,
  config.enableObd,
  config.enableTracker,
].filter(Boolean).length;
const totalActiveDevices = config.vehicles * activeDevicesPerVehicle;

console.log(`\n[CONFIG] ── Device Types ──────────────────`);
console.log(
  `[CONFIG] Dashcam:        ${config.enableDashcam ? "ENABLED" : "DISABLED"}`,
);
console.log(
  `[CONFIG] OBD2:           ${config.enableObd ? "ENABLED" : "DISABLED"}`,
);
console.log(
  `[CONFIG] Tracker:        ${config.enableTracker ? "ENABLED" : "DISABLED"}`,
);
console.log(`[CONFIG] ── Dashcam Features ──────────────`);
console.log(
  `[CONFIG] GPS send:       ${config.enableGps ? `ENABLED (every ${config.gpsInterval}s)` : "DISABLED"}`,
);
console.log(
  `[CONFIG] AI Incidents:   ${config.enableIncidents ? `ENABLED (every ${config.incidentInterval}s at ${config.incidentChance}%)` : "DISABLED"}`,
);
console.log(
  `[CONFIG] Video Upload:   ${config.enableVideo ? "ENABLED" : "DISABLED"}`,
);
console.log(
  `[CONFIG] Live Streaming: ${config.enableLiveStream ? "ENABLED" : "DISABLED"}`,
);
console.log(`[CONFIG] ── OBD2 Features ─────────────────`);
console.log(
  `[CONFIG] Telemetry:      ${config.enableObd ? `ENABLED (every ${config.obdInterval}s)` : "DISABLED"}`,
);
console.log(
  `[CONFIG] DTC Faults:     ${config.enableObd ? `ENABLED (every ${config.dtcInterval}s at ${config.dtcChance}%)` : "DISABLED"}`,
);
console.log(`[CONFIG] ── Network ───────────────────────`);
console.log(`[CONFIG] Server:         ${SERVER_HOST}`);
console.log(
  `[CONFIG] Vehicles:       ${config.vehicles} (${totalActiveDevices} active devices)`,
);
console.log(
  `[CONFIG] Device IDs loaded from: ${path.join(__dirname, "data", "devices.json")}\n`,
);
const activeSimulators = [];
let isShuttingDown = false;

const shutdown = () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(
    "\n[SYSTEM] Shutdown signal received. Shutting down gracefully...",
  );
  // NOTE: In-flight HTTP video uploads (up to 15s timeout) are aborted on exit.

  activeSimulators.forEach((sim) => {
    try {
      if (typeof sim.stop === "function") sim.stop();
    } catch (err) {
      console.error("[SYSTEM] Error stopping simulator:", err.message);
    }
  });

  setTimeout(() => {
    logger.printSummary();
    process.exit(0);
  }, 2000);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const selectedVehicles = deviceDb.slice(0, config.vehicles);

selectedVehicles.forEach((vehicle, i) => {
  const startupDelay = i * 150;

  setTimeout(() => {
    if (config.enableDashcam) {
      const dashcam = new DashcamSimulator({
        host: SERVER_HOST,
        port: PORTS.DASHCAM,
        deviceId: vehicle.dashcamId,
        vehicleId: vehicle.vehicleId,
        index: i,
        config, // <--- CRITICAL FIX: Explicitly passing config here
      });
      dashcam.start();
      activeSimulators.push(dashcam);
    }

    if (config.enableObd) {
      const obd2 = new OBD2Simulator({
        host: SERVER_HOST,
        port: PORTS.OBD2,
        deviceId: vehicle.obd2Id,
        vehicleId: vehicle.vehicleId,
        config, // <--- CRITICAL FIX: Explicitly passing config here
      });
      obd2.start();
      activeSimulators.push(obd2);
    }

    if (config.enableTracker) {
      const tracker = new TrackerSimulator({
        host: SERVER_HOST,
        port: PORTS.TRACKER,
        deviceId: vehicle.trackerId,
        vehicleId: vehicle.vehicleId,
      });
      tracker.start();
      activeSimulators.push(tracker);
    }
  }, startupDelay);
});
