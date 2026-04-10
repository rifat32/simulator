"use strict";

const net = require("net");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

// Helper to load and parse H.264 frames from a file
function parseH264File(filename) {
    try {
        const videoPath = path.join(__dirname, "../data", filename);
        if (!fs.existsSync(videoPath)) return null;

        const VIDEO_BUFFER = fs.readFileSync(videoPath);
        const NAL_UNITS = [];
        const delimiter = Buffer.from([0x00, 0x00, 0x00, 0x01]);
        let offset = VIDEO_BUFFER.indexOf(delimiter);

        while (offset !== -1 && offset < VIDEO_BUFFER.length) {
            let nextOffset = VIDEO_BUFFER.indexOf(delimiter, offset + 4);
            if (nextOffset === -1) {
                NAL_UNITS.push(VIDEO_BUFFER.subarray(offset));
                break;
            }
            const frame = VIDEO_BUFFER.subarray(offset, nextOffset);
            if (frame.length < 65000) {
                NAL_UNITS.push(frame);
            }
            offset = nextOffset;
        }
        return NAL_UNITS;
    } catch (err) {
        console.log(`[SYSTEM] Error loading ${filename}: ${err.message}`);
        return null;
    }
}

class LiveStreamer {
  constructor(deviceId, phoneBcd, config) {
    this.deviceId = deviceId;
    this.phoneBcd = phoneBcd;
    this.config = config;

    this.socket = null;
    this.interval = null;
    this.sequence = 0;
    this.frameIndex = 0;
    this.nalUnits = [];
  }

  handleRequest(body, defaultHost) {
    try {
      const ipLen = body.readUInt8(0);
      const ip = body
        .subarray(1, 1 + ipLen)
        .toString("ascii")
        .replace(/\0/g, "");
      const tcpPort = body.readUInt16BE(1 + ipLen);
      const channel = body.readUInt8(5 + ipLen);

      logger.log(
        "INFO",
        this.deviceId,
        "LIVE_STREAM_REQ",
        `Target: ${ip}:${tcpPort} | Channel: ${channel}`,
      );

      if (!this.config.enableLiveStream) return;

      // REMOVED 127.0.0.1 SO LOCAL TESTING WORKS!
      const mediaHost = !ip || ip === "0.0.0.0" ? defaultHost : ip;

      this.start(mediaHost, tcpPort, channel);
    } catch (err) {
      logger.log("ERROR", this.deviceId, "9101_PARSE_ERROR", err.message);
    }
  }

  start(host, port, channel) {
    this.stop();

    // Revert to test.h264 for all channels as baseline
    this.nalUnits = parseH264File("test.h264");

    if (!this.nalUnits || this.nalUnits.length === 0) {
      logger.log(
        "ERROR",
        this.deviceId,
        "LIVE_STREAM_FAIL",
        `No video frames for CH${channel}. Checked ch${channel}.h264 and test.h264`,
      );
      return;
    }

    logger.log(
      "INFO",
      this.deviceId,
      "LIVE_STREAM_CONNECTING",
      `${host}:${port} | CH${channel}`,
    );
    this.sequence = 0;
    this.frameIndex = 0;

    setTimeout(() => {
      this.socket = net.createConnection(port, host, () => {
        logger.log(
          "INFO",
          this.deviceId,
          "LIVE_STREAM_CONNECTED",
          "Pumping real video frames...",
        );

        // Pump one frame every 40ms (approx 25 frames per second)
        this.interval = setInterval(() => {
          if (!this.socket || this.socket.destroyed) {
            this.stop();
            return;
          }

          const chunk = this.nalUnits[this.frameIndex++];
          if (this.frameIndex >= this.nalUnits.length) this.frameIndex = 0; // Loop the video

          // Determine if this is an I-Frame (Keyframe) or P-Frame
          // Index 4 because JT/T 1078 frames used here start with 00 00 00 01
          const nalType = chunk.length > 4 ? chunk[4] & 0x1f : 0;
          let dataType = 1; // Default to P-Frame
          if (nalType === 5 || nalType === 7 || nalType === 8) {
            dataType = 0; // I-Frame, SPS, or PPS
          }

          // Build JT/T 1078 RTP Streaming Header (30 Bytes)
          const rtpHeader = Buffer.alloc(30, 0);
          rtpHeader.writeUInt32BE(0x30316364, 0);
          rtpHeader.writeUInt8(0x81, 4);
          rtpHeader.writeUInt8(98, 5);
          rtpHeader.writeUInt16BE(this.sequence++ & 0xffff, 6);
          this.phoneBcd.copy(rtpHeader, 8, 0, 6);
          rtpHeader.writeUInt8(channel, 14);
          rtpHeader.writeUInt8(dataType, 15); // Reverting to low-nibble as it was in working version

          const timestamp = Date.now();
          rtpHeader.writeBigUInt64BE(BigInt(timestamp), 16);
          rtpHeader.writeUInt16BE(chunk.length, 28);

          const packet = Buffer.concat([rtpHeader, chunk]);
          this.socket.write(packet);
        }, 40);
      });

      this.socket.on("error", (err) => {
        console.error(`[LIVE-ERROR] Failed to connect to ${host}:${port}: ${err.message}`);
        logger.log("ERROR", this.deviceId, "LIVE_STREAM_ERR", err.message);
      });

      this.socket.on("close", () => {
        logger.log("INFO", this.deviceId, "LIVE_STREAM_CLOSED", "Stream ended.");
        this.stop();
      });
    }, 100);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

module.exports = { LiveStreamer };
