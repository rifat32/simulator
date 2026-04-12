const net = require("net");
// Pointing to the new dense Essex routes to avoid driving through houses!
const { routes } = require("../data/essex_routes");
const logger = require("../utils/logger");

class OBD2Simulator {
  constructor({ host, port, deviceId, vehicleId, index = 0, config = {} }) {
    this.host = host;
    this.port = port;
    this.deviceId = deviceId;
    this.vehicleId = vehicleId;
    this.config = config;

    this.socket = null;
    this.binaryBuffer = Buffer.alloc(0);
    this.msgSerial = 0;

    // 1. Bulletproof check for missing route data
    if (!routes || Object.keys(routes).length === 0) {
      throw new Error(
        `[${this.deviceId}] No routes found! Please check data/essex_routes.js`,
      );
    }

    // 2. Safe fallback for the index
    const safeIndex = index === undefined ? 0 : index;
    const routeKeys = Object.keys(routes);

    this.routePoints = routes[routeKeys[safeIndex % routeKeys.length]];

    // 3. Bulletproof check to ensure the route was loaded successfully
    if (!this.routePoints || this.routePoints.length < 2) {
      throw new Error(
        `[${this.deviceId}] Route must have at least 2 waypoints`,
      );
    }

    this.currentWaypoint = 0;
    this.progress = Math.min(0.9, (safeIndex % 10) * 0.1);
    this.speedKmh = 40;

    this.currentSegmentDistanceKm = this.getDistanceKm(
      this.routePoints[this.currentWaypoint],
      this.routePoints[this.currentWaypoint + 1],
    );

    // J63S Physics State
    this.rpm = 1500;
    this.engineLoad = 30;
    this.coolantTemp = 90;
    this.batteryVoltage = 14.2;
    this.throttlePos = 15;
    this.mileage = 150000;

    this.interval = null;
    this.dtcInterval = null;
    this.heartbeatInterval = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;

    // --- REALISTIC FLEET AI ---
    // Start everyone with a base location so parked cars don't send null
    this.currentLocation = { lat: this.routePoints[0].lat, lng: this.routePoints[0].lng };
    
    // Only 30% of vehicles are "defective" and allowed to send DTCs
    this.isDefective = Math.random() < 0.30; 
    
    // States: "MOVING", "PARKED", "OFFLINE"
    this.currentState = "MOVING"; 
    this.realismTimer = null;
  }

  // --- JT/T 808 PROTOCOL ENGINE ---
  escapeJT808(buf) {
    const res = [];
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x7e) {
        res.push(0x7d, 0x02);
      } else if (buf[i] === 0x7d) {
        res.push(0x7d, 0x01);
      } else {
        res.push(buf[i]);
      }
    }
    return Buffer.from(res);
  }

  getBcdTime() {
    const d = new Date();
    const str = `${(d.getUTCFullYear() % 100).toString().padStart(2, "0")}${(d.getUTCMonth() + 1).toString().padStart(2, "0")}${d.getUTCDate().toString().padStart(2, "0")}${d.getUTCHours().toString().padStart(2, "0")}${d.getUTCMinutes().toString().padStart(2, "0")}${d.getUTCSeconds().toString().padStart(2, "0")}`;
    return Buffer.from(str, "hex");
  }

  buildJT808Packet(msgId, bodyBuf) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(msgId, 0);
    header.writeUInt16BE(bodyBuf.length, 2);

    const phoneBcd = Buffer.from(this.deviceId.padStart(12, "0"), "hex");
    phoneBcd.copy(header, 4);

    header.writeUInt16BE(this.msgSerial++, 10);

    const unescaped = Buffer.concat([header, bodyBuf]);

    let checksum = 0;
    for (let i = 0; i < unescaped.length; i++) {
      checksum ^= unescaped[i];
    }

    const escapedData = this.escapeJT808(unescaped);
    const escapedChecksum = this.escapeJT808(Buffer.from([checksum]));

    return Buffer.concat([
      Buffer.from([0x7e]),
      escapedData,
      escapedChecksum,
      Buffer.from([0x7e]),
    ]);
  }

  // --- EXACT J63S PAYLOAD BUILDERS ---
  buildLocationAndObdBody(location) {
    // <--- Add 'location' here
    let status = 3; // <--- Remove the interpolate line
    let lat = location.lat;
    let lng = location.lng;

    if (lat < 0) {
      status |= 1 << 2;
      lat = Math.abs(lat);
    }
    if (lng < 0) {
      status |= 1 << 3;
      lng = Math.abs(lng);
    }

    const baseBody = Buffer.alloc(28);
    baseBody.writeUInt32BE(0, 0);
    baseBody.writeUInt32BE(status, 4);
    baseBody.writeUInt32BE(Math.round(lat * 1000000), 8);
    baseBody.writeUInt32BE(Math.round(lng * 1000000), 12);
    baseBody.writeUInt16BE(10, 16);
    baseBody.writeUInt16BE(Math.round(this.speedKmh * 10), 18);
    baseBody.writeUInt16BE(0, 20);
    this.getBcdTime().copy(baseBody, 22);

    const milBlock = Buffer.alloc(6);
    milBlock.writeUInt8(0x01, 0);
    milBlock.writeUInt8(0x04, 1);
    milBlock.writeUInt32BE(Math.round(this.mileage), 2);

    const innerData = [];
    const addPid = (id16, len, valBuf) => {
      const b = Buffer.alloc(2 + 1 + len);
      b.writeUInt16BE(id16, 0);
      b.writeUInt8(len, 2);
      valBuf.copy(b, 3);
      innerData.push(b);
    };

    const rpmBuf = Buffer.alloc(2);
    rpmBuf.writeUInt16BE(Math.round(this.rpm), 0);
    addPid(0x0003, 2, rpmBuf);

    const voltBuf = Buffer.alloc(2);
    voltBuf.writeUInt16BE(Math.round(this.batteryVoltage * 1000), 0);
    addPid(0x0004, 2, voltBuf);

    const loadBuf = Buffer.alloc(1);
    loadBuf.writeUInt8(Math.round(this.engineLoad), 0);
    addPid(0x0008, 1, loadBuf);

    const tempBuf = Buffer.alloc(1);
    tempBuf.writeUInt8(Math.round(this.coolantTemp + 40), 0);
    addPid(0x0009, 1, tempBuf);

    const throttleBuf = Buffer.alloc(1);
    throttleBuf.writeUInt8(Math.round((this.throttlePos * 255) / 100), 0);
    addPid(0x0011, 1, throttleBuf);

    const innerBuffer = Buffer.concat(innerData);

    const f3Block = Buffer.alloc(2 + innerBuffer.length);
    f3Block.writeUInt8(0xf3, 0);
    f3Block.writeUInt8(innerBuffer.length, 1);
    innerBuffer.copy(f3Block, 2);

    return Buffer.concat([baseBody, milBlock, f3Block]);
  }

  start() {
    this.connect();
    this.resumeIntervals();
  }

  pauseIntervals() {
    clearInterval(this.interval);
    clearInterval(this.dtcInterval);
    clearInterval(this.heartbeatInterval);
    clearInterval(this.realismTimer); // <--- Add this!
  }

  resumeIntervals() {
    this.pauseIntervals();

    const obdMs = (this.config.obdInterval || 15) * 1000;
    this.interval = setInterval(() => this.sendOBD2Data(), obdMs);

    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 30000);

    // 🚨 1. Start the Realism Engine! (Checks state every 20 seconds)
    this.realismTimer = setInterval(() => this.simulateRealism(), 20000);

    // 🚨 2. Restrict DTCs to Defective Vehicles only
    const dtcMs = (this.config.dtcInterval || 60) * 1000;
    const dtcProb = (this.config.dtcChance || 5) / 100;

    this.dtcInterval = setInterval(() => {
      if (this.isDefective && this.currentState !== "OFFLINE") {
        if (Math.random() <= dtcProb) {
          this.sendDiagnosticCode(); 
        }
      }
    }, dtcMs);
  }

  connect() {
    this.socket = net.createConnection(this.port, this.host, () => {
      this.reconnectAttempt = 0;
      logger.log("INFO", this.deviceId, "OBD2_CONNECTED", "Binary Mode");

      // 1. Send 0x0100 Registration
      const regBody = Buffer.alloc(30, 0);
      this.safeWrite(this.buildJT808Packet(0x0100, regBody));

      // 2. Send 0x0102 Authentication
      setTimeout(() => {
        const authBody = Buffer.from("123456", "ascii");
        this.safeWrite(this.buildJT808Packet(0x0102, authBody));
      }, 500);
    });

    this.socket.on("data", (data) => {
      const hex = data.toString("hex").toUpperCase();
      if (hex.includes("8001"))
        logger.log(
          "INFO",
          this.deviceId,
          "SERVER_ACK",
          "0x8001 Universal Reply Received",
        );
      if (hex.includes("8100"))
        logger.log(
          "INFO",
          this.deviceId,
          "SERVER_ACK",
          "0x8100 Registration Reply Received",
        );
    });

    this.socket.on("error", (err) => {
      logger.log("ERROR", this.deviceId, "SOCKET_ERROR", err.code);
    });

    this.socket.on("close", () => {
      this.pauseIntervals();
      const backoff = Math.min(
        30000,
        1000 * Math.pow(2, this.reconnectAttempt),
      );
      this.reconnectAttempt++;
      logger.log(
        "INFO",
        this.deviceId,
        "RECONNECTING",
        `OBD2 Backoff ${backoff}ms`,
      );
      this.reconnectTimer = setTimeout(() => this.connect(), backoff);
    });
  }

  safeWrite(data) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable)
      return false;
    const ok = this.socket.write(data);
    if (!ok) {
      this.pauseIntervals();
      this.socket.once("drain", () => this.resumeIntervals());
    }
    return ok;
  }

  getDistanceKm(p1, p2) {
    const R = 6371;
    const dLat = (p2.lat - p1.lat) * (Math.PI / 180);
    const dLng = (p2.lng - p1.lng) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(p1.lat * (Math.PI / 180)) *
        Math.cos(p2.lat * (Math.PI / 180)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  }

  interpolateLocation() {
    let p1 = this.routePoints[this.currentWaypoint];
    let p2 = this.routePoints[this.currentWaypoint + 1];

    if (
      !isFinite(this.currentSegmentDistanceKm) ||
      this.currentSegmentDistanceKm < 0.001
    ) {
      this.currentWaypoint =
        (this.currentWaypoint + 1) % (this.routePoints.length - 1);
      this.progress = 0;
      this.currentSegmentDistanceKm = this.getDistanceKm(
        this.routePoints[this.currentWaypoint],
        this.routePoints[this.currentWaypoint + 1],
      );
      const p = this.routePoints[this.currentWaypoint];
      return { lat: p.lat, lng: p.lng };
    }

    const distanceThisTick = (this.speedKmh / 3600) * 15;
    this.progress += distanceThisTick / this.currentSegmentDistanceKm;
    this.mileage += distanceThisTick * 10;

    let iterations = 0;
    while (this.progress >= 1.0 && iterations++ < 100) {
      this.progress -= 1.0;
      this.currentWaypoint =
        (this.currentWaypoint + 1) % (this.routePoints.length - 1);
      p1 = this.routePoints[this.currentWaypoint];
      p2 = this.routePoints[this.currentWaypoint + 1];
      this.currentSegmentDistanceKm = this.getDistanceKm(p1, p2);
    }
    if (iterations >= 100) {
      this.progress = 0;
    }

    return {
      lat: p1.lat + (p2.lat - p1.lat) * this.progress,
      lng: p1.lng + (p2.lng - p1.lng) * this.progress,
    };
  }

  simulateRealism() {
    if (this.currentState === "OFFLINE") return; // Dead devices stay dead

    const roll = Math.random();
    if (this.currentState === "MOVING") {
      if (roll < 0.15) { 
        // 15% chance to Park
        this.currentState = "PARKED";
        logger.log("WARN", this.deviceId, "VEHICLE_PARKED", "Ignition OFF, GPS Locked.");
      } else if (roll < 0.20) { 
        // 5% chance to completely drop Offline
        this.currentState = "OFFLINE";
        logger.log("ERROR", this.deviceId, "COMM_LOST", "Device unplugged/Lost signal.");
        this.stop(); // Kills the socket and timers entirely
      }
    } else if (this.currentState === "PARKED") {
      if (roll < 0.40) { 
        // 40% chance a parked car starts driving again
        this.currentState = "MOVING";
        logger.log("INFO", this.deviceId, "VEHICLE_MOVING", "Ignition ON, Driving resumed.");
      }
    }
  }

  sendOBD2Data() {
    if (this.currentState === "OFFLINE") return;

    if (this.currentState === "PARKED") {
      // Vehicle is stopped: 0 Speed, Engine Idling, Location frozen
      this.speedKmh = 0;
      this.rpm = 0; 
      // Notice we DO NOT call interpolateLocation() here. The GPS stays the same!
    } else {
      // Vehicle is moving: Normal dynamic physics
      this.speedKmh = Math.max(10, Math.min(100, this.speedKmh + (Math.random() - 0.5) * 10));
      this.rpm = 800 + (this.speedKmh / 100) * 4000;
      this.engineLoad = Math.min(100, (this.speedKmh / 100) * 100);
      this.throttlePos = this.engineLoad;
      this.coolantTemp = Math.max(88, Math.min(105, this.coolantTemp + (this.engineLoad > 60 ? 0.5 : -0.5)));
      
      // Advance the GPS coordinates along the route
      this.currentLocation = this.interpolateLocation();
    }

    const body = this.buildLocationAndObdBody(this.currentLocation);
    const packet = this.buildJT808Packet(0x0200, body);

    const ok = this.safeWrite(packet);
    if (ok) {
      logger.inc("gpsPackets");
      logger.inc("obdPackets"); 
      
      logger.log(
        "INFO",
        this.deviceId,
        "OBD2_SENT_0x0200",
        `[${this.currentState}] Lat: ${this.currentLocation.lat.toFixed(6)}, Lng: ${this.currentLocation.lng.toFixed(6)} | Speed: ${Math.round(this.speedKmh)}km/h`
      );
    }
  }

  sendHeartbeat() {
    // Emits an empty 0x0002 packet
    const packet = this.buildJT808Packet(0x0002, Buffer.alloc(0));
    if (this.safeWrite(packet)) {
      logger.log("INFO", this.deviceId, "HEARTBEAT_SENT", "0x0002");
    }
  }

  sendDiagnosticCode() {
    const codes = ["P0420", "P0300", "P0171", "C1234"];
    const dtcStr = codes[Math.floor(Math.random() * codes.length)];
    const asciiBuf = Buffer.from(dtcStr, "ascii");

    const body0900 = Buffer.alloc(12 + asciiBuf.length, 0);
    body0900.writeUInt8(0xf8, 0);
    body0900.writeUInt16BE(asciiBuf.length, 3);
    asciiBuf.copy(body0900, 12);

    const packet0900 = this.buildJT808Packet(0x0900, body0900);

    if (this.safeWrite(packet0900)) {
      logger.inc("dtcsSent"); // <--- Update this to match the new counter!
      logger.log(
        "INFO",
        this.deviceId,
        "DTC_SENT_0x0900",
        `Injected Fault Code: ${dtcStr}`,
      );
    }
  }

  stop() {
    this.pauseIntervals();
    clearTimeout(this.reconnectTimer);
    this.reconnectAttempt = 0;

    if (this.socket && !this.socket.destroyed) {
      logger.log("INFO", this.deviceId, "DISCONNECTED", "clean stop");
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

module.exports = { OBD2Simulator };
