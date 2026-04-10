// Resolves: The setImmediate temporal gap by guarding writeNext with socket.destroyed.
const net = require("net");
const logger = require("../utils/logger");

const protocol = require("../utils/jtt808");

class TrackerSimulator {
  constructor({ host, port, deviceId, vehicleId }) {
    this.host = host;
    this.port = port;
    this.deviceId = deviceId;
    this.imei = protocol.parseDeviceIdToIMEI(deviceId);

    const seed = this.deviceId
      .split("")
      .reduce((acc, c) => acc + c.charCodeAt(0), 0);
    this.pseudoRandom = ((seed * 9301 + 49297) % 233280) / 233280;

    this.baseLocation = {
      lat: 51.5072 + (this.pseudoRandom - 0.5) * 0.5,
      lng: -0.1276 + (this.pseudoRandom - 0.5) * 0.5,
    };

    this.battery = 100.0;
    this.offlineQueue = [];
    this.isTransmitting = false;
    this.interval = null;
    this.initialTimer = null;
    this.activeSocket = null;
    this.tcpBufferBuffer = Buffer.alloc(0);
    this.status = "OFFLINE";
  }

  start() {
    const initialDelay = this.pseudoRandom * 300000;
    this.initialTimer = setTimeout(() => this.wakeAndTransmit(), initialDelay);
    this.interval = setInterval(() => this.wakeAndTransmit(), 300000);
  }

  wakeAndTransmit() {
    if (this.isTransmitting) return;

    if (this.battery <= 0) {
      logger.warn(this.deviceId, "BATTERY_DEPLETED", "Device offline");
      clearInterval(this.interval);
      return;
    }

    this.isTransmitting = true;
    this.battery = Math.max(0, this.battery - 0.1);

    const currentPayload = {
      lat: this.baseLocation.lat + (Math.random() - 0.5) * 0.001,
      lng: this.baseLocation.lng + (Math.random() - 0.5) * 0.001,
      timestamp: Date.now(),
    };

    this.offlineQueue.push(currentPayload);

    this.activeSocket = net.createConnection(this.port, this.host, () => {
      this.tcpBufferBuffer = Buffer.alloc(0);
      this.status = "CONNECTED";
      logger.info(this.deviceId, "CONNECTED", `IMEI:${this.imei}`);

      const body = protocol.buildRegisterBody(
        this.imei,
        `SIM-${this.deviceId}`,
      );
      this.sendJTT808(protocol.MSG_ID.REGISTER, body);
    });

    this.activeSocket.on("data", (data) => {
      this.tcpBufferBuffer = Buffer.concat([this.tcpBufferBuffer, data]);
      const result = protocol.extractFrames(this.tcpBufferBuffer);
      this.tcpBufferBuffer = result.remaining;

      for (const frame of result.frames) {
        const unescaped = protocol.unescapeBuffer(frame.slice(1, -1));
        if (unescaped.length < 12) continue;
        const msgId = unescaped.readUInt16BE(0);

        if (msgId === 0x8100) {
          const res = unescaped[14];
          if (res === 0) {
            this.authCode = unescaped.slice(15, -1).toString();
            this.sendJTT808(protocol.MSG_ID.AUTH, Buffer.from(this.authCode));
          }
        } else if (msgId === 0x8001) {
          const respId = unescaped.readUInt16BE(14);
          const respResult = unescaped[16];
          if (respId === protocol.MSG_ID.AUTH && respResult === 0) {
            this.status = "AUTHENTICATED";
            this.flushQueue(this.activeSocket);
          }
        }
      }
    });

    this.activeSocket.on("error", (err) => {
      logger.log(
        "ERROR",
        this.deviceId,
        "SOCKET_ERROR",
        err.code || err.message,
      );
      this.isTransmitting = false;
      this.activeSocket = null;
    });
  }

  sendJTT808(msgId, body) {
    if (!this.activeSocket || this.activeSocket.destroyed) return false;
    const packet = protocol.buildPacket(this.imei, msgId, body);
    this.activeSocket.write(packet);
    return true;
  }

  flushQueue(socket) {
    if (this.offlineQueue.length === 0) {
      socket.end();
      this.isTransmitting = false;
      return;
    }

    const snapshot = [...this.offlineQueue];
    let index = 0;

    socket.once("finish", () => {
      logger.info(
        this.deviceId,
        "FLUSH_COMPLETE",
        `${snapshot.length} payloads delivered`,
      );
      this.offlineQueue.splice(0, snapshot.length);
      this.isTransmitting = false;
      this.activeSocket = null;
    });

    const writeNext = () => {
      if (index >= snapshot.length) {
        socket.end();
        return;
      }

      if (socket.destroyed) return;

      const p = snapshot[index];
      const body = protocol.buildLocationBody(p.lat, p.lng, 0, 0);
      this.sendJTT808(protocol.MSG_ID.LOCATION, body);

      logger.info(
        this.deviceId,
        "TRACKER_SENT",
        `battery:${Math.round(this.battery)}%`,
      );
      logger.counters.trackerSent++;
      index++;
      setImmediate(writeNext);
    };

    writeNext();
  }

  stop() {
    clearTimeout(this.initialTimer);
    clearInterval(this.interval);
    this.isTransmitting = false;

    logger.log("INFO", this.deviceId, "DISCONNECTED", "clean stop");

    if (this.activeSocket && !this.activeSocket.destroyed) {
      this.activeSocket.removeAllListeners();
      this.activeSocket.destroy();
      this.activeSocket = null;
    }
  }
}

module.exports = { TrackerSimulator };
