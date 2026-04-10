"use strict";

const net = require("net");
const { LiveStreamer } = require("./liveStreamer");
const { routes } = require("../data/uk_routes");
const logger = require("../utils/logger");
const fs = require("fs");
const path = require("path");

// ─── Mock Media Buffers ────────────────────────────────────────────────────────
// Valid 1×1 JPEG so server magic-byte check passes
const tinyJpegBase64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U" +
  "HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIA" +
  "AhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAU" +
  "AQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8A" +
  "KwAB/9k=";
let MOCK_IMAGE_BUFFER = Buffer.from(tinyJpegBase64, "base64");

// Valid MP4 ftyp box so server magic-byte check passes
let MOCK_VIDEO_BUFFER = Buffer.alloc(64 * 1024, 0x00);
MOCK_VIDEO_BUFFER.set(
  [
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
    0x00, 0x00, 0x00, 0x00, 0x6d, 0x70, 0x34, 0x31, 0x6d, 0x70, 0x34, 0x32,
  ],
  0,
);

// Load real image and video
try {
  const realImg = fs.readFileSync(path.join(__dirname, "..", "test.jpg"));
  if (realImg && realImg.length > 0) {
    MOCK_IMAGE_BUFFER = realImg;
  }
} catch (e) {
  console.log(`⚠️ Archive 2 could not load test.jpg: ${e.message}`);
}

try {
  const realVideo = fs.readFileSync(path.join(__dirname, "..", "test_video.mp4"));
  if (realVideo && realVideo.length > 0) {
    MOCK_VIDEO_BUFFER = realVideo;
  }
} catch (e) {
  console.log(`⚠️ Archive 2 could not load test_video.mp4: ${e.message}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getBcdTime() {
  const d = new Date();
  const s =
    (d.getUTCFullYear() % 100).toString().padStart(2, "0") +
    (d.getUTCMonth() + 1).toString().padStart(2, "0") +
    d.getUTCDate().toString().padStart(2, "0") +
    d.getUTCHours().toString().padStart(2, "0") +
    d.getUTCMinutes().toString().padStart(2, "0") +
    d.getUTCSeconds().toString().padStart(2, "0");
  return Buffer.from(s, "hex");
}

function escapeJT808(buf) {
  const r = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7e) r.push(0x7d, 0x02);
    else if (buf[i] === 0x7d) r.push(0x7d, 0x01);
    else r.push(buf[i]);
  }
  return Buffer.from(r);
}

function unescapeJT808(buf) {
  const r = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === 0x7d && i + 1 < buf.length) {
      if (buf[i + 1] === 0x02) {
        r.push(0x7e);
        i += 2;
        continue;
      }
      if (buf[i + 1] === 0x01) {
        r.push(0x7d);
        i += 2;
        continue;
      }
    }
    r.push(buf[i++]);
  }
  return Buffer.from(r);
}

// ─── Main Class ───────────────────────────────────────────────────────────────
class DashcamSimulator {
  constructor({ host, port, deviceId, vehicleId, index, config, imei }) {
    this.host = host;
    this.port = port;
    this.deviceId = deviceId;
    this.vehicleId = vehicleId;
    this.config = config;

    // ── Phone BCD: use the IMEI passed from devices.json ──────────────────
    // This MUST match exactly what the server has registered for this device.
    // The server uses this to set socketDeviceId and build the file path.
    // If no imei passed, derive from deviceId digits (fallback only).
    let numericId;
    if (imei) {
      numericId = imei.replace(/\D/g, "").padStart(12, "0").slice(0, 12);
    } else {
      const rawDigits = deviceId.replace(/\D/g, "");
      numericId = ("86812001" + rawDigits.padStart(4, "0")).slice(0, 12);
    }
    this.phoneBcd = Buffer.from(numericId, "hex"); // 6 bytes
    this.numericId = numericId;

    this.socket = null;
    this.binaryBuffer = Buffer.alloc(0);
    this.msgSerial = 0;
    this.mediaIdCounter = 1;
    // Initialize the separated Live Streamer module
    this.liveStreamer = new LiveStreamer(
      this.deviceId,
      this.phoneBcd,
      this.config,
    );

    const routeKeys = Object.keys(routes);
    this.routePoints = routes[routeKeys[index % routeKeys.length]];
    if (this.routePoints.length < 2)
      throw new Error(
        `[${this.deviceId}] Route must have at least 2 waypoints`,
      );

    this.currentWaypoint = 0;
    this.progress = Math.min(0.9, (index % 10) * 0.1);
    this.speedKmh = 105;
    this.currentSegmentDistanceKm = this.getDistanceKm(
      this.routePoints[0],
      this.routePoints[1],
    );

    this.gpsInterval = null;
    this.incidentInterval = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  // ── JT808 Packet Builder ─────────────────────────────────────────────────
  buildJT808Packet(msgId, bodyBuf) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(msgId, 0);
    header.writeUInt16BE(bodyBuf.length & 0x03ff, 2);
    this.phoneBcd.copy(header, 4);
    header.writeUInt16BE(this.msgSerial++ & 0xffff, 10);
    const raw = Buffer.concat([header, bodyBuf]);
    let cs = 0;
    for (let i = 0; i < raw.length; i++) cs ^= raw[i];
    return Buffer.concat([
      Buffer.from([0x7e]),
      escapeJT808(raw),
      escapeJT808(Buffer.from([cs])),
      Buffer.from([0x7e]),
    ]);
  }

  // ── Location Body ────────────────────────────────────────────────────────
  buildLocationBody(alarmFlag = 0) {
    const loc = this.interpolateLocation();
    let status = 0x00000003;
    let lat = loc.lat,
      lng = loc.lng;
    if (lat < 0) {
      status |= 1 << 2;
      lat = Math.abs(lat);
    }
    if (lng < 0) {
      status |= 1 << 3;
      lng = Math.abs(lng);
    }
    const body = Buffer.alloc(28);
    body.writeUInt32BE(alarmFlag, 0);
    body.writeUInt32BE(status, 4);
    body.writeUInt32BE(Math.round(lat * 1e6), 8);
    body.writeUInt32BE(Math.round(lng * 1e6), 12);
    body.writeUInt16BE(10, 16);
    body.writeUInt16BE(Math.round(this.speedKmh * 10), 18);
    body.writeUInt16BE(0, 20);
    getBcdTime().copy(body, 22);
    return body;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  start() {
    this.connect();
    this.resumeIntervals();
  }

  pauseIntervals() {
    clearInterval(this.gpsInterval);
    clearInterval(this.incidentInterval);
    this.gpsInterval = null;
    this.incidentInterval = null;
  }

  resumeIntervals() {
    this.pauseIntervals();
    if (this.config.enableGps) {
      this.gpsInterval = setInterval(
        () => this.sendGPS(),
        this.config.gpsInterval * 1000,
      );
    }
    if (this.config.enableIncidents) {
      this.incidentInterval = setInterval(() => {
        if (Math.random() * 100 < this.config.incidentChance)
          this.sendAIIncident();
      }, this.config.incidentInterval * 1000);
    }
  }

  // ── TCP Connection ───────────────────────────────────────────────────────
  connect() {
    this.socket = net.createConnection(this.port, this.host, () => {
      this.reconnectAttempt = 0;
      this.binaryBuffer = Buffer.alloc(0);
      logger.log("INFO", this.deviceId, "CONNECTED", `id:${this.numericId}`);
      const authBody = Buffer.from("123456", "ascii");
      this.safeWrite(this.buildJT808Packet(0x0102, authBody));
    });

    this.socket.on("data", (data) => {
      this.binaryBuffer = Buffer.concat([this.binaryBuffer, data]);
      this._drainFrames();
    });

    this.socket.on("error", (err) => {
      logger.log(
        "ERROR",
        this.deviceId,
        "SOCKET_ERROR",
        err.code || err.message,
      );
    });

    this.socket.on("close", () => {
      this.pauseIntervals();
      const backoff = Math.min(
        30000,
        1000 * Math.pow(2, this.reconnectAttempt),
      );
      const jitter = Math.random() * 1000;
      this.reconnectAttempt++;
      logger.log(
        "INFO",
        this.deviceId,
        "RECONNECTING",
        `attempt ${this.reconnectAttempt}, backoff ${Math.round(backoff + jitter)}ms`,
      );
      this.reconnectTimer = setTimeout(() => this.connect(), backoff + jitter);
    });
  }

  // ── Frame Parser ─────────────────────────────────────────────────────────
  _drainFrames() {
    while (this.binaryBuffer.length > 0) {
      const start = this.binaryBuffer.indexOf(0x7e);
      if (start === -1) {
        this.binaryBuffer = Buffer.alloc(0);
        break;
      }
      const end = this.binaryBuffer.indexOf(0x7e, start + 1);
      if (end === -1) {
        this.binaryBuffer = this.binaryBuffer.subarray(start);
        break;
      }
      const frame = this.binaryBuffer.subarray(start, end + 1);
      this.binaryBuffer = this.binaryBuffer.subarray(end + 1);
      if (frame.length < 4) continue;
      try {
        this._handleFrame(frame);
      } catch (err) {
        logger.log("ERROR", this.deviceId, "PARSE_ERROR", err.message);
      }
    }
  }

  _handleFrame(frame) {
    const inner = unescapeJT808(frame.subarray(1, frame.length - 1));
    if (inner.length < 12) return;
    const msgId = inner.readUInt16BE(0);
    const attrs = inner.readUInt16BE(2);
    const bodyLen = attrs & 0x03ff;
    const bodyOffset = attrs & 0x2000 ? 16 : 12;
    const body = inner.subarray(bodyOffset, bodyOffset + bodyLen);

    logger.log(
      "INFO",
      this.deviceId,
      "RX_MSG",
      `0x${msgId.toString(16).padStart(4, "0").toUpperCase()} bodyLen=${bodyLen}`,
    );

    if (msgId === 0x8001) {
      if (body.length < 5) return;
      const replyId = body.readUInt16BE(2);
      const result = body.readUInt8(4);
      logger.log(
        "INFO",
        this.deviceId,
        "SERVER_ACK",
        `0x${replyId.toString(16).padStart(4, "0").toUpperCase()} result=${result === 0 ? "OK" : "FAIL(" + result + ")"}`,
      );
    } else if (msgId === 0x9208) {
      this._handle9208(body);
    } else if (msgId === 0x9101) {
      // 1. Extract the Server's Sequence Number from the header (bytes 10-11)
      const serverSeq = inner.readUInt16BE(10);

      // 2. Build the 0x0001 Terminal General Reply Body (5 bytes)
      const ackBody = Buffer.alloc(5);
      ackBody.writeUInt16BE(serverSeq, 0); // The sequence number we are replying to
      ackBody.writeUInt16BE(0x9101, 2); // The command ID we are acknowledging
      ackBody.writeUInt8(0x00, 4); // 0x00 = Success / Will Comply

      // 3. Send the ACK back to the server
      this.safeWrite(this.buildJT808Packet(0x0001, ackBody));
      logger.log(
        "INFO",
        this.deviceId,
        "SENT_ACK",
        "0x0001 acknowledging Live Stream Request",
      );

      // 4. NOW we can start the actual video stream
      this.liveStreamer.handleRequest(body, this.host);
    }
  }

  // ── Handle 0x9208 ────────────────────────────────────────────────────────
  _handle9208(body) {
    try {
      logger.log(
        "INFO",
        this.deviceId,
        "9208_RAW",
        body.toString("hex").toUpperCase(),
      );

      const ipLen = body.readUInt8(0);
      const ip = body
        .subarray(1, 1 + ipLen)
        .toString("ascii")
        .replace(/\0/g, "");
      const tcpPort = body.readUInt16BE(1 + ipLen);
      const alarmId16 = Buffer.from(body.subarray(5 + ipLen, 21 + ipLen));
      const alarmNo32 = Buffer.from(body.subarray(21 + ipLen, 53 + ipLen));

      const hexId = alarmId16.toString("hex").toUpperCase();
      logger.log(
        "INFO",
        this.deviceId,
        "UPLOAD_TRIGGERED",
        `media: ${ip}:${tcpPort} | alarmId: ${hexId}`,
      );

      if (!this.config.enableVideo) {
        logger.log("INFO", this.deviceId, "VIDEO_SKIPPED", "enableVideo=false");
        return;
      }

      // If server sends 0.0.0.0 or loopback, fall back to control server host
      const mediaHost =
        !ip || ip === "0.0.0.0" || ip === "127.0.0.1" ? this.host : ip;
      const mediaPort = tcpPort || this.port;

      this._uploadBatch(mediaHost, mediaPort, alarmId16, alarmNo32);
    } catch (err) {
      logger.log("ERROR", this.deviceId, "9208_PARSE_ERROR", err.message);
    }
  }

  // ── THE CORRECTED UPLOAD METHOD ──────────────────────────────────────────
  //
  // ROOT CAUSE (confirmed by reading media-server.js):
  //
  // The media server has THREE parsing branches:
  //   A) Raw 0x30316364 marker  → fs.writeFileSync / appendFileSync  (WRITES FILE)
  //   B) 0x7e JT808 frames      → handles 0x1210 / 0x1211 / 0x1212  (NO file write)
  //   C) JT1078 live stream     → ffmpeg pipe
  //
  // fs.writeFileSync and fs.appendFileSync ONLY exist in Branch A.
  // Branch B for 0x1211 just sends a generalReply and DISCARDS the data.
  //
  // The previous simulator sent ALL data inside 0x7e-framed 0x1211 packets
  // (Branch B), so the server ACKed them but NEVER wrote any bytes to disk.
  // This is why the URL was generated (0x1212 was processed) but the file
  // was empty / 404.
  //
  // CORRECT PROTOCOL (what this server actually expects):
  //   1. Send 0x7e [0x1210]  → server ACKs, sets socketDeviceId = phoneBCD
  //   2. Send RAW [0x30316364 marker packet] → server writes file to disk
  //   3. Send 0x7e [0x1212]  → server ACKs, updates DB path
  //
  // The 0x30316364 marker packet format (from looksLikeAIUploadHeader):
  //   Bytes  0- 3: marker 0x30 0x31 0x63 0x64
  //   Bytes  4-53: filename, 50 bytes, ASCII null-padded (must have ≥40 printable/null)
  //   Bytes 54-57: 4 reserved zero bytes
  //   Bytes 58-61: dataLength as UInt32BE
  //   Bytes 62+  : raw file bytes (dataLength bytes)
  //
  _uploadBatch(mediaHost, mediaPort, alarmId16, alarmNo32) {
    const hexId = alarmId16.toString("hex").toUpperCase();

    // File definitions — names must match what server built in its URL
    // Image: type 0 = jpg, Video: type 2 = mp4
    const fileBatch = [
      {
        name: `00_64_6401_00_${hexId}.jpg`,
        type: 0,
        buffer: MOCK_IMAGE_BUFFER,
      },
      {
        name: `02_64_6401_03_${hexId}.mp4`,
        type: 2,
        buffer: MOCK_VIDEO_BUFFER,
      },
    ];

    logger.log(
      "INFO",
      this.deviceId,
      "MEDIA_CONNECTING",
      `${mediaHost}:${mediaPort} files=${fileBatch.length}`,
    );

    const mediaSocket = net.createConnection(mediaPort, mediaHost);
    let mediaSerial = 0;

    // Media socket uses its own serial counter, same phoneBcd as control
    const buildMediaPacket = (msgId, bodyBuf) => {
      const header = Buffer.alloc(12);
      header.writeUInt16BE(msgId, 0);
      header.writeUInt16BE(bodyBuf.length & 0x03ff, 2);
      this.phoneBcd.copy(header, 4);
      header.writeUInt16BE(mediaSerial++ & 0xffff, 10);
      const raw = Buffer.concat([header, bodyBuf]);
      let cs = 0;
      for (let i = 0; i < raw.length; i++) cs ^= raw[i];
      return Buffer.concat([
        Buffer.from([0x7e]),
        escapeJT808(raw),
        escapeJT808(Buffer.from([cs])),
        Buffer.from([0x7e]),
      ]);
    };

    // Build a raw 0x30316364 marker packet for one file
    // This is Branch A format — what the server actually uses to write the file
    const buildRawFilePacket = (fileName, fileBuffer) => {
      const MARKER = Buffer.from([0x30, 0x31, 0x63, 0x64]);

      // Filename field: exactly 50 bytes, ASCII, null-padded
      const nameBuf = Buffer.alloc(50, 0x00);
      const nameBytes = Buffer.from(fileName, "ascii");
      if (nameBytes.length > 50) {
        // Truncate if somehow longer than 50 — should not happen with our names
        nameBytes.copy(nameBuf, 0, 0, 50);
      } else {
        nameBytes.copy(nameBuf, 0);
      }

      // 4 reserved bytes (not validated by server)
      const reserved = Buffer.alloc(4, 0x00);

      // Data length as UInt32BE
      const dataLen = Buffer.alloc(4);
      dataLen.writeUInt32BE(fileBuffer.length, 0);

      // Total: 4 + 50 + 4 + 4 + fileBuffer.length = 62 + fileBuffer.length
      return Buffer.concat([MARKER, nameBuf, reserved, dataLen, fileBuffer]);
    };

    let fileIndex = 0;

    const uploadNextFile = () => {
      if (fileIndex >= fileBatch.length) {
        logger.log(
          "INFO",
          this.deviceId,
          "BATCH_COMPLETE",
          `All ${fileBatch.length} files sent`,
        );
        logger.inc("videosOk");
        mediaSocket.end();
        return;
      }

      const file = fileBatch[fileIndex];
      const fileNameBuf = Buffer.from(file.name, "ascii");
      logger.log(
        "INFO",
        this.deviceId,
        "FILE_START",
        `[${fileIndex + 1}/${fileBatch.length}] ${file.name} (${file.buffer.length} bytes)`,
      );

      // ── Step 1: Send 0x7e [0x1210] so server sets socketDeviceId ─────────
      // termId(7) + alarmId16(16) + alarmNo32(32) + infoType(1) + attachCount(1)
      //   + nameLen(1) + name(N) + fileSize(4)
      const termId = Buffer.alloc(7, 0x00);
      this.phoneBcd.copy(termId, 0, 0, 6); // bytes 0-5 = phone BCD

      const body1210 = Buffer.allocUnsafe(
        7 + 16 + 32 + 1 + 1 + 1 + fileNameBuf.length + 4,
      );
      let off = 0;
      termId.copy(body1210, off);
      off += 7;
      alarmId16.copy(body1210, off);
      off += 16;
      alarmNo32.copy(body1210, off);
      off += 32;
      body1210.writeUInt8(0x00, off++); // infoType: normal
      body1210.writeUInt8(fileBatch.length, off++); // attachCount = 2
      body1210.writeUInt8(fileNameBuf.length, off++); // nameLen
      fileNameBuf.copy(body1210, off);
      off += fileNameBuf.length;
      body1210.writeUInt32BE(file.buffer.length, off);

      mediaSocket.write(buildMediaPacket(0x1210, body1210));
      logger.log("INFO", this.deviceId, "SENT_1210", file.name);

      // ── Step 2: Send raw 0x30316364 packet — server writes file to disk ──
      // Wait 100ms so server processes 0x1210 and sets socketDeviceId first
      setTimeout(() => {
        const rawPacket = buildRawFilePacket(file.name, file.buffer);

        logger.log(
          "INFO",
          this.deviceId,
          "SENT_RAW_MARKER",
          `${file.name} packet=${rawPacket.length} bytes data=${file.buffer.length} bytes`,
        );

        mediaSocket.write(rawPacket, () => {
          // ── Step 3: Send 0x7e [0x1212] to signal file complete ───────────
          // Server processes 0x1212, sends 0x9212 reply, updates DB
          const body1212 = Buffer.allocUnsafe(1 + fileNameBuf.length + 1 + 1);
          body1212.writeUInt8(fileNameBuf.length, 0);
          fileNameBuf.copy(body1212, 1);
          body1212.writeUInt8(file.type, 1 + fileNameBuf.length);
          body1212.writeUInt8(0x00, 1 + fileNameBuf.length + 1); // result OK

          mediaSocket.write(buildMediaPacket(0x1212, body1212), () => {
            logger.log(
              "INFO",
              this.deviceId,
              "SENT_1212",
              `${file.name} type=${file.type}`,
            );
            fileIndex++;
            // Brief pause between files so server can process
            setTimeout(uploadNextFile, 300);
          });
        });
      }, 100);
    };

    mediaSocket.on("connect", () => {
      logger.log(
        "INFO",
        this.deviceId,
        "MEDIA_CONNECTED",
        `${mediaHost}:${mediaPort}`,
      );
      // NO auth packet on media socket — server does not expect it
      // Start uploading immediately
      uploadNextFile();
    });

    mediaSocket.on("data", (data) => {
      // Log server responses (ACKs and 0x9212 replies)
      logger.log(
        "INFO",
        this.deviceId,
        "MEDIA_RX",
        data
          .toString("hex")
          .toUpperCase()
          .match(/.{1,2}/g)
          ?.join(" ") || "",
      );
    });

    mediaSocket.on("error", (err) => {
      logger.inc("videosFail");
      logger.log(
        "ERROR",
        this.deviceId,
        "MEDIA_ERROR",
        `${mediaHost}:${mediaPort} — ${err.message}`,
      );
    });

    mediaSocket.on("close", () => {
      logger.log("INFO", this.deviceId, "MEDIA_CLOSED", "");
    });
  }

  // ── Send GPS ─────────────────────────────────────────────────────────────
  sendGPS() {
    const body = this.buildLocationBody(0);
    const ok = this.safeWrite(this.buildJT808Packet(0x0200, body));
    if (ok) {
      logger.inc("gpsPackets");
      logger.log("INFO", this.deviceId, "GPS_SENT", "");
    }
  }

  // ── Send AI Incident ─────────────────────────────────────────────────────
  sendAIIncident() {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return;

    const mediaId = this.mediaIdCounter++;
    const bcdTime = getBcdTime();

    // alarmId16: bytes 0-5 = phoneBcd, byte 6 = 0, bytes 7-12 = timestamp,
    //            byte 13 = serial, byte 14 = attachCount, byte 15 = reserved
    const alarmId16 = Buffer.alloc(16, 0);
    this.phoneBcd.copy(alarmId16, 0, 0, 6);
    alarmId16.writeUInt8(0, 6);
    bcdTime.copy(alarmId16, 7);
    alarmId16.writeUInt8(mediaId & 0xff, 13);
    alarmId16.writeUInt8(fileBatch_attachCount(), 14); // 2 files
    alarmId16.writeUInt8(0, 15);

    const hexId = alarmId16.toString("hex").toUpperCase();

    // 47-byte ADAS payload (extension 0x64)
    const adasPayload = Buffer.alloc(47, 0);
    adasPayload.writeUInt32BE(mediaId, 0);
    adasPayload.writeUInt8(0x00, 4);
    adasPayload.writeUInt8(0x01, 5); // alarm type: FCW
    adasPayload.writeUInt8(0x01, 6); // level
    adasPayload.writeUInt8(31, 7);
    adasPayload.writeUInt8(10, 8);
    adasPayload.writeUInt8(this.speedKmh & 0xff, 12);
    const loc = this.interpolateLocation();
    adasPayload.writeUInt32BE(Math.round(Math.abs(loc.lat) * 1e6), 15);
    adasPayload.writeUInt32BE(Math.round(Math.abs(loc.lng) * 1e6), 19);
    bcdTime.copy(adasPayload, 23);
    adasPayload.writeUInt16BE(0x0401, 29);
    alarmId16.copy(adasPayload, 31);

    const adasBlock = Buffer.alloc(49);
    adasBlock.writeUInt8(0x64, 0);
    adasBlock.writeUInt8(47, 1);
    adasPayload.copy(adasBlock, 2);

    // 0x0200 location with alarm flag + ADAS extension
    const alarmFlag = 1 << 18;
    const locBody = this.buildLocationBody(alarmFlag);
    this.safeWrite(
      this.buildJT808Packet(0x0200, Buffer.concat([locBody, adasBlock])),
    );

    // 0x0800 media event notification — triggers server to send 0x9208
    const mediaBody = Buffer.alloc(8);
    mediaBody.writeUInt32BE(mediaId, 0);
    mediaBody.writeUInt8(2, 4); // type: video
    mediaBody.writeUInt8(4, 5); // format: MP4
    mediaBody.writeUInt8(3, 6); // event: alarm
    mediaBody.writeUInt8(1, 7); // channel: 1
    this.safeWrite(this.buildJT808Packet(0x0800, mediaBody));

    logger.inc("incidentsFired");
    logger.log(
      "INFO",
      this.deviceId,
      "INCIDENT_SENT",
      `mediaId=${mediaId} alarmId=${hexId}`,
    );
  }

  // ── Safe Write ───────────────────────────────────────────────────────────
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

  // ── Haversine + Interpolation ────────────────────────────────────────────
  getDistanceKm(p1, p2) {
    const R = 6371;
    const dLat = (p2.lat - p1.lat) * (Math.PI / 180);
    const dLng = (p2.lng - p1.lng) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(p1.lat * (Math.PI / 180)) *
      Math.cos(p2.lat * (Math.PI / 180)) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  interpolateLocation() {
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
    const tickDist = (this.speedKmh / 3600) * this.config.gpsInterval;
    this.progress += tickDist / this.currentSegmentDistanceKm;
    let p1 = this.routePoints[this.currentWaypoint];
    let p2 = this.routePoints[this.currentWaypoint + 1];
    let iters = 0;
    while (this.progress >= 1.0 && iters++ < 100) {
      this.progress -= 1.0;
      this.currentWaypoint =
        (this.currentWaypoint + 1) % (this.routePoints.length - 1);
      p1 = this.routePoints[this.currentWaypoint];
      p2 = this.routePoints[this.currentWaypoint + 1];
      this.currentSegmentDistanceKm = this.getDistanceKm(p1, p2);
    }
    if (iters >= 100) this.progress = 0;
    return {
      lat: p1.lat + (p2.lat - p1.lat) * this.progress,
      lng: p1.lng + (p2.lng - p1.lng) * this.progress,
    };
  }

  // ── Stop ─────────────────────────────────────────────────────────────────
  stop() {
    this.pauseIntervals();
    clearTimeout(this.reconnectTimer);
    this.reconnectAttempt = 0;
    // Stop the live streamer
    this.liveStreamer.stop();
    if (this.socket && !this.socket.destroyed) {
      logger.log("INFO", this.deviceId, "DISCONNECTED", "clean stop");
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

// Helper used in sendAIIncident to keep attachCount consistent with fileBatch
function fileBatch_attachCount() {
  return 2;
} // image + video

module.exports = { DashcamSimulator };
