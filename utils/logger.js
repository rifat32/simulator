const fs = require("fs");
const path = require("path");

class Logger {
  constructor() {
    this.startTime = Date.now();
    this.counters = {
      gpsPackets: 0,
      obdPackets: 0,
      dtcsSent: 0,
      incidentsFired: 0,
      videosOk: 0,
      videosFail: 0,
      trackerPings: 0,
      reconnections: 0,
    };

    const logDir = path.join(__dirname, "..", "logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.logFileName = `logs/sim-${timestamp}.log`;
    this.logFilePath = path.join(__dirname, "..", this.logFileName);

    this.stream = fs.createWriteStream(this.logFilePath, { flags: "a" });
  }

  log(level, device, event, detail = "") {
    const entry = {
      ts: new Date().toISOString(),
      level,
      device,
      event,
      detail: detail.toString(),
    };
    const line = JSON.stringify(entry);
    console.log(line);
    this.stream.write(line + "\n");
  }

  inc(counterName) {
    if (this.counters[counterName] !== undefined) {
      this.counters[counterName]++;
      // 🚨 ADD THIS TRAP:
      // console.log(`[DEBUG] Successfully counted 1 more for: ${counterName}`);
    } else {
      // 🚨 ADD THIS TRAP:
      console.log(
        `[DEBUG ERROR] Tried to count "${counterName}", but it doesn't exist in this.counters!`,
      );
    }
  }

  printSummary() {
    const durationSecs = Math.round((Date.now() - this.startTime) / 1000);
    const summary = [
      `\n[SUMMARY] Run duration: ${durationSecs}s`,
      `[SUMMARY] GPS packets sent: ${this.counters.gpsPackets}`,
      `[SUMMARY] OBD2 packets sent: ${this.counters.obdPackets}`,
      `[SUMMARY] DTC faults sent: ${this.counters.dtcsSent}`,
      `[SUMMARY] Incidents fired: ${this.counters.incidentsFired}`,
      `[SUMMARY] Videos uploaded OK: ${this.counters.videosOk}`,
      `[SUMMARY] Videos failed: ${this.counters.videosFail}`,
      `[SUMMARY] Tracker pings sent: ${this.counters.trackerPings}`,
      `[SUMMARY] Reconnections: ${this.counters.reconnections}`,
      `[SUMMARY] Log file: ${this.logFileName}`,
    ].join("\n");

    console.log(summary);
    this.stream.write(summary + "\n");
    this.stream.end();
  }
}

module.exports = new Logger();
